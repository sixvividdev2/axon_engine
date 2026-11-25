import * as THREE from 'three';
import { BodycamPhysicsWorld, PhysicsDynamicSlab } from '../bodycam-sdk/BodycamPhysics';
import { PenetrableSurfaceSystem } from './PenetrableSurfaceSystem';

export type DoorDamageState = 0 | 1 | 2 | 3;
export type DoorHingeMode = 'attached' | 'sheared_flying' | 'splitting' | 'collapsed';
export type DoorDestructionOutcome = 'none' | 'hinge_shear' | 'split_collapse';
export type DoorInteractOptionId = 'open' | 'peek' | 'close' | 'close_soft' | 'kick' | 'repair';
export type DoorAudioCueKind =
  | 'knob_turn'
  | 'latch_soft'
  | 'slam'
  | 'wood_dent'
  | 'wood_crack'
  | 'wood_breach'
  | 'kick_breach'
  | 'hinge_shear'
  | 'wood_split'
  | 'slab_crash'
  | 'repair';

export interface DoorInteractOption {
  id: DoorInteractOptionId;
  label: string;
  hint?: string;
}

export interface DoorAcousticEvent {
  doorId: string;
  position: THREE.Vector3;
  radiusM: number;
  loudness: number;
  kind: DoorAudioCueKind;
  actorTeam?: 'A' | 'B' | 'FFA';
}

export interface DoorSpec {
  id: string;
  label?: string;
  /** World-space hinge bottom pivot [x, floorY, z] */
  hingePos: [number, number, number];
  /** Yaw (rad) of closed slab extending along local +X -> world (cos yaw, 0, -sin yaw) */
  closedYawRad: number;
  /** Fixed architectural swing direction (+1 = toward local -Z, -1 = toward local +Z) */
  swingSign: 1 | -1;
  width?: number;
  height?: number;
  thickness?: number;
  maxOpenRad?: number;
  repairable?: boolean;
  style?: 'bunker_wood' | 'tactical_reinforced';
  /** Optional transom/jamb frame surround */
  addFrameJamb?: boolean;
}

export interface SyncedDoorSnapshot {
  doorId: string;
  angleRad: number;
  angularVel: number;
  latched: boolean;
  damageState: DoorDamageState;
  chipDamage: number;
  hingeMode: DoorHingeMode;
  destructionOutcome: DoorDestructionOutcome;
  seed: number;
}

export interface DoorActionPayload {
  doorId: string;
  action:
    | 'open'
    | 'peek'
    | 'close'
    | 'close_soft'
    | 'kick_breach'
    | 'kick_destroy'
    | 'melee_bash'
    | 'bullet_chip'
    | 'nudge'
    | 'repair';
  angleRad: number;
  angularVel: number;
  latched: boolean;
  damageState: DoorDamageState;
  chipDamage: number;
  hingeMode: DoorHingeMode;
  destructionOutcome: DoorDestructionOutcome;
  seed: number;
  px?: number;
  py?: number;
  pz?: number;
  dx?: number;
  dy?: number;
  dz?: number;
}

interface DebrisBodyState {
  group: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  floorY: number;
  halfThickness: number;
  layFlatPitchSign: 1 | -1;
  active: boolean;
  settled: boolean;
  bounced: boolean;
}

interface SplinterParticle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  age: number;
  maxAge: number;
  floorY: number;
  active: boolean;
}

export interface DestructibleDoorRuntime {
  readonly id: string;
  readonly label: string;
  readonly spec: Required<DoorSpec>;
  readonly frameGroup: THREE.Group;
  readonly hingePivot: THREE.Group;
  readonly slabContainer: THREE.Group;
  readonly lowerHalfGroup: THREE.Group;
  readonly upperHalfGroup: THREE.Group;
  readonly centerBreachPanel: THREE.Mesh;
  readonly dentOverlays: THREE.Group;
  readonly crackOverlays: THREE.Group;
  readonly breachSplinterRim: THREE.Group;
  readonly splitEdgeLower: THREE.Group;
  readonly splitEdgeUpper: THREE.Group;
  readonly knobFront: THREE.Object3D;
  readonly knobBack: THREE.Object3D;
  readonly pushPointFront: THREE.Object3D;
  readonly pushPointBack: THREE.Object3D;
  readonly interactProxy: THREE.Mesh;
  readonly frameRepairProxy: THREE.Mesh;
  readonly dynamicSlab: PhysicsDynamicSlab;

  // Dynamic physics state
  angleRad: number;
  angularVel: number;
  latched: boolean;
  softClosing: boolean;
  damageState: DoorDamageState;
  chipDamage: number;
  hingeMode: DoorHingeMode;
  destructionOutcome: DoorDestructionOutcome;
  destructionSeed: number;
  splitCollapseTimerSec: number;
  nudgeBroadcastCooldown: number;
  jambShudderTimer: number;
  kickCooldownTimer: number;
  lastKickDir: THREE.Vector3;

  // Detached rigid debris kinematics (Outcome A & B)
  shearedBody: DebrisBodyState;
  upperSplitBody: DebrisBodyState;
  lowerSplitBody: DebrisBodyState;
}

const CHIP_DAMAGE_PER_STAGE = 125;
const LATCH_ANGLE_RAD = 0.055; // ~3.15°
const SPRINT_DESTROY_SPEED_MPS = 4.35;

interface SharedDoorMaterials {
  woodBunker: THREE.MeshStandardMaterial;
  woodReinforced: THREE.MeshStandardMaterial;
  rawSplinterWood: THREE.MeshStandardMaterial;
  dentDark: THREE.MeshStandardMaterial;
  frameSteel: THREE.MeshStandardMaterial;
  brassHardware: THREE.MeshStandardMaterial;
  hingeIron: THREE.MeshStandardMaterial;
  sparkMat: THREE.MeshBasicMaterial;
  proxyMat: THREE.MeshBasicMaterial;
  textures: THREE.Texture[];
}

function makeDoorWoodTexture(baseHex: string, grainHex: string, darkHex: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 256, 512);

  // Vertical plank wood grain & subtle Cold-War wear streaks
  for (let i = 0; i < 420; i++) {
    const x = (i * 53) % 256;
    const y = (i * 97) % 512;
    const h = 40 + ((i * 29) % 140);
    ctx.fillStyle = i % 3 === 0 ? darkHex : grainHex;
    ctx.globalAlpha = 0.08 + ((i * 17) % 10) * 0.014;
    ctx.fillRect(x, y, 2 + (i % 3), h);
  }
  ctx.globalAlpha = 0.24;
  ctx.strokeStyle = darkHex;
  ctx.lineWidth = 3;
  // Recessed stile & panel outline framing
  ctx.strokeRect(18, 20, 220, 472);
  ctx.strokeRect(36, 42, 184, 210);
  ctx.strokeRect(36, 276, 184, 196);
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function createSharedDoorMaterials(): SharedDoorMaterials {
  const woodTex1 = makeDoorWoodTexture('#4c392a', '#634c38', '#221811');
  const woodTex2 = makeDoorWoodTexture('#3a4245', '#4c575b', '#1c2124');

  return {
    woodBunker: new THREE.MeshStandardMaterial({
      map: woodTex1,
      roughness: 0.78,
      metalness: 0.06,
    }),
    woodReinforced: new THREE.MeshStandardMaterial({
      map: woodTex2,
      roughness: 0.62,
      metalness: 0.26,
    }),
    rawSplinterWood: new THREE.MeshStandardMaterial({
      color: 0xa68356,
      roughness: 0.9,
      metalness: 0.02,
    }),
    dentDark: new THREE.MeshStandardMaterial({
      color: 0x1b140f,
      roughness: 0.95,
      metalness: 0.04,
    }),
    frameSteel: new THREE.MeshStandardMaterial({
      color: 0x262a2f,
      roughness: 0.56,
      metalness: 0.68,
    }),
    brassHardware: new THREE.MeshStandardMaterial({
      color: 0xb6954f,
      roughness: 0.34,
      metalness: 0.84,
    }),
    hingeIron: new THREE.MeshStandardMaterial({
      color: 0x1b1e22,
      roughness: 0.48,
      metalness: 0.82,
    }),
    sparkMat: new THREE.MeshBasicMaterial({ color: 0xffcf6b }),
    proxyMat: new THREE.MeshBasicMaterial({ visible: false }),
    textures: [woodTex1, woodTex2],
  };
}

/**
 * Lightweight WebAudio procedural Foley synthesizer for tactical doors:
 * doorknob clicks, stealth soft latch, heavy wood slam, melee dent/crack/breach,
 * boot impact, hinge shear, wood split, and floor crash (zero external assets).
 */
class DoorAudioSynth {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private masterGain = 0.65;

  public setVolume(v: number): void {
    this.masterGain = THREE.MathUtils.clamp(v, 0, 1);
  }

  private ensureCtx(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    }
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      const len = Math.floor(this.ctx.sampleRate * 0.6);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.45));
      }
      this.noiseBuffer = buf;
      return this.ctx;
    } catch {
      return null;
    }
  }

  public play(kind: DoorAudioCueKind, distM = 2): void {
    const ctx = this.ensureCtx();
    if (!ctx || !this.noiseBuffer) return;
    const atten = THREE.MathUtils.clamp(1 / (1 + Math.max(0, distM - 1.5) * 0.16), 0.04, 1);
    const vol = this.masterGain * atten;
    if (vol < 0.015) return;
    const now = ctx.currentTime;

    const triggerNoise = (freq: number, q: number, dur: number, gainAmt: number, delay = 0) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const filt = ctx.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.setValueAtTime(freq, now + delay);
      filt.Q.setValueAtTime(q, now + delay);
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(0.0001, gainAmt * vol), now + delay);
      g.gain.exponentialRampToValueAtTime(0.0001, now + delay + dur);
      src.connect(filt).connect(g).connect(ctx.destination);
      src.start(now + delay);
      src.stop(now + delay + dur + 0.02);
    };

    const triggerThump = (startHz: number, endHz: number, dur: number, gainAmt: number, delay = 0) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(startHz, now + delay);
      osc.frequency.exponentialRampToValueAtTime(Math.max(24, endHz), now + delay + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(Math.max(0.0001, gainAmt * vol), now + delay);
      g.gain.exponentialRampToValueAtTime(0.0001, now + delay + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(now + delay);
      osc.stop(now + delay + dur + 0.02);
    };

    switch (kind) {
      case 'knob_turn':
        triggerNoise(2200, 3.5, 0.055, 0.34, 0);
        triggerNoise(1400, 2.2, 0.045, 0.24, 0.065);
        break;
      case 'latch_soft':
        triggerNoise(1150, 2.8, 0.05, 0.16, 0);
        triggerThump(130, 58, 0.06, 0.14, 0.01);
        break;
      case 'slam':
        triggerThump(118, 36, 0.19, 0.85, 0);
        triggerNoise(520, 1.1, 0.16, 0.58, 0);
        triggerNoise(1650, 2.0, 0.07, 0.32, 0.02);
        break;
      case 'wood_dent':
        triggerThump(145, 48, 0.13, 0.65, 0);
        triggerNoise(760, 1.4, 0.12, 0.45, 0);
        break;
      case 'wood_crack':
        triggerThump(135, 44, 0.15, 0.72, 0);
        triggerNoise(1080, 1.2, 0.18, 0.62, 0);
        triggerNoise(2400, 2.2, 0.09, 0.38, 0.03);
        break;
      case 'wood_breach':
        triggerThump(128, 38, 0.22, 0.88, 0);
        triggerNoise(920, 0.9, 0.28, 0.82, 0);
        triggerNoise(2600, 1.8, 0.15, 0.52, 0.04);
        break;
      case 'kick_breach':
        triggerThump(110, 32, 0.24, 0.95, 0);
        triggerNoise(640, 1.0, 0.20, 0.72, 0);
        triggerNoise(1950, 2.4, 0.08, 0.42, 0.015);
        break;
      case 'hinge_shear':
        triggerThump(96, 28, 0.28, 1.0, 0);
        triggerNoise(3100, 3.2, 0.16, 0.68, 0);
        triggerNoise(840, 0.8, 0.26, 0.78, 0.02);
        break;
      case 'wood_split':
        triggerThump(104, 32, 0.26, 0.95, 0);
        triggerNoise(1240, 1.1, 0.34, 0.85, 0);
        triggerNoise(2700, 1.6, 0.22, 0.56, 0.06);
        break;
      case 'slab_crash':
        triggerThump(90, 26, 0.28, 0.86, 0);
        triggerNoise(420, 0.9, 0.24, 0.65, 0);
        break;
      case 'repair':
        triggerNoise(1500, 2.4, 0.07, 0.36, 0);
        triggerThump(160, 82, 0.08, 0.32, 0.06);
        break;
    }
  }
}

/**
 * Modular, Physics-Driven Destructible Door System shared by 3D Hideout and Combat Maps.
 * Features:
 *  - Fixed single-direction hinges with smooth angular damping & capsule body-bump nudging
 *  - Dynamic multi-option [F] scroll actions (Open / Peek / Kick / Close / Close Soft / Open-if-ajar / Repair)
 *  - 4-Stage progressive melee & gunfire destruction (0 Intact -> 1 Dented -> 2 Cracked -> 3 Real Breached Hole)
 *  - Velocity-based Kick Breaching (Standing/Walking Breach Kick vs. Sprinting Outcome A Hinge Shear / Outcome B Split & Collapse)
 *  - Zero-GC runtime loop & deterministic multiplayer state export/apply
 */
export class DestructibleDoorSystem {
  private readonly root = new THREE.Group();
  private readonly particleRoot = new THREE.Group();
  private readonly physics: BodycamPhysicsWorld;
  private readonly isSoftwareGl: boolean;
  private readonly materials: SharedDoorMaterials;
  private readonly synth = new DoorAudioSynth();
  private readonly penSystem: PenetrableSurfaceSystem;
  private readonly trackedGeos: THREE.BufferGeometry[] = [];
  private readonly doors = new Map<string, DestructibleDoorRuntime>();
  private readonly doorList: DestructibleDoorRuntime[] = [];
  private readonly interactableMeshes: THREE.Mesh[] = [];
  private readonly raycastDoorMeshes: THREE.Object3D[] = [];
  private readonly splinters: SplinterParticle[] = [];

  private onAcousticEvent: ((ev: DoorAcousticEvent) => void) | null = null;
  private onActionBroadcast: ((payload: DoorActionPayload) => void) | null = null;
  private listenerPos = new THREE.Vector3();

  // Scratch vectors (zero GC; launch/remote vectors isolated from detach/burst helpers)
  private readonly _tmpV1 = new THREE.Vector3();
  private readonly _tmpV2 = new THREE.Vector3();
  private readonly _tmpV3 = new THREE.Vector3();
  private readonly _tmpLaunchDir = new THREE.Vector3();
  private readonly _tmpFaceNormal = new THREE.Vector3();
  private readonly _tmpRemotePt = new THREE.Vector3();
  private readonly _tmpRemoteDir = new THREE.Vector3();
  private readonly _tmpQ1 = new THREE.Quaternion();
  private readonly _tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(parent: THREE.Object3D, physics: BodycamPhysicsWorld, isSoftwareGl: boolean) {
    this.physics = physics;
    this.isSoftwareGl = isSoftwareGl;
    this.materials = createSharedDoorMaterials();
    this.root.name = 'DestructibleDoorsRoot';
    this.particleRoot.name = 'DoorSplinterPool';
    parent.add(this.root);
    parent.add(this.particleRoot);
    this.penSystem = new PenetrableSurfaceSystem(parent, { isSoftwareGl });
    this.initSplinterPool();
  }

  public setAudioVolume(vol: number): void {
    this.synth.setVolume(vol);
  }

  public setAcousticListener(cb: ((ev: DoorAcousticEvent) => void) | null): void {
    this.onAcousticEvent = cb;
  }

  public setActionBroadcastListener(cb: ((payload: DoorActionPayload) => void) | null): void {
    this.onActionBroadcast = cb;
  }

  public getInteractableMeshes(): THREE.Mesh[] {
    return this.interactableMeshes;
  }

  public getRaycastMeshes(): THREE.Object3D[] {
    return this.raycastDoorMeshes;
  }

  public getDoors(): readonly DestructibleDoorRuntime[] {
    return this.doorList;
  }

  public getDoor(doorId: string): DestructibleDoorRuntime | undefined {
    return this.doors.get(doorId);
  }

  private trackGeo<T extends THREE.BufferGeometry>(g: T): T {
    this.trackedGeos.push(g);
    return g;
  }

  private initSplinterPool(): void {
    const splinterGeo = this.trackGeo(new THREE.BoxGeometry(0.032, 0.016, 0.16));
    const sparkGeo = this.trackGeo(new THREE.BoxGeometry(0.018, 0.018, 0.045));
    for (let i = 0; i < 64; i++) {
      const isSpark = i >= 52;
      const mesh = new THREE.Mesh(
        isSpark ? sparkGeo : splinterGeo,
        isSpark ? this.materials.sparkMat : this.materials.rawSplinterWood,
      );
      mesh.visible = false;
      this.particleRoot.add(mesh);
      this.splinters.push({
        mesh,
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        age: 0,
        maxAge: 1,
        floorY: 0,
        active: false,
      });
    }
  }

  private spawnBurst(
    origin: Readonly<THREE.Vector3>,
    dir: Readonly<THREE.Vector3>,
    count: number,
    floorY: number,
    sparksOnly = false,
  ): void {
    let spawned = 0;
    const startIdx = sparksOnly ? 52 : 0;
    const endIdx = sparksOnly ? 64 : 52;
    for (let i = startIdx; i < endIdx && spawned < count; i++) {
      const p = this.splinters[i];
      if (p.active) continue;
      p.active = true;
      p.age = 0;
      p.maxAge = sparksOnly ? 0.35 + Math.random() * 0.25 : 1.1 + Math.random() * 0.9;
      p.floorY = floorY + 0.012;
      p.mesh.visible = true;
      p.mesh.position.set(
        origin.x + (Math.random() - 0.5) * 0.26,
        origin.y + (Math.random() - 0.5) * 0.34,
        origin.z + (Math.random() - 0.5) * 0.26,
      );
      p.mesh.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      const spd = sparksOnly ? 2.8 + Math.random() * 3.4 : 1.8 + Math.random() * 3.8;
      p.vel.set(
        dir.x * spd + (Math.random() - 0.5) * 2.4,
        0.9 + Math.random() * 2.4,
        dir.z * spd + (Math.random() - 0.5) * 2.4,
      );
      p.angVel.set(
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
      );
      spawned++;
    }
  }

  public addDoor(rawSpec: DoorSpec): DestructibleDoorRuntime {
    const spec: Required<DoorSpec> = {
      id: rawSpec.id,
      label: rawSpec.label ?? 'Door',
      hingePos: [...rawSpec.hingePos] as [number, number, number],
      closedYawRad: rawSpec.closedYawRad,
      swingSign: rawSpec.swingSign,
      width: rawSpec.width ?? 1.16,
      height: rawSpec.height ?? 2.24,
      thickness: rawSpec.thickness ?? 0.07,
      maxOpenRad: rawSpec.maxOpenRad ?? THREE.MathUtils.degToRad(104),
      repairable: rawSpec.repairable ?? true,
      style: rawSpec.style ?? 'bunker_wood',
      addFrameJamb: rawSpec.addFrameJamb ?? true,
    };

    const W = spec.width;
    const H = spec.height;
    const T = spec.thickness;
    const splitY = H * 0.48; // ~1.075m split line
    const stileW = 0.21;
    const topRailH = 0.26;
    const holeW = Math.max(0.46, W - stileW * 2);
    const holeBottomY = splitY + 0.02;
    const holeH = Math.max(0.55, H - topRailH - holeBottomY);
    const holeCenterX = W * 0.5;
    const holeCenterY = holeBottomY + holeH * 0.5;

    const slabMat =
      spec.style === 'tactical_reinforced'
        ? this.materials.woodReinforced
        : this.materials.woodBunker;

    const frameGroup = new THREE.Group();
    frameGroup.name = `door_frame_${spec.id}`;
    frameGroup.position.set(spec.hingePos[0], spec.hingePos[1], spec.hingePos[2]);
    frameGroup.rotation.y = spec.closedYawRad;
    this.root.add(frameGroup);

    // Optional crisp metal/timber doorframe jambs & top header
    if (spec.addFrameJamb) {
      const jambGeo = this.trackGeo(new THREE.BoxGeometry(0.065, H + 0.06, T + 0.06));
      const leftJamb = new THREE.Mesh(jambGeo, this.materials.frameSteel);
      leftJamb.position.set(-0.032, (H + 0.06) * 0.5, 0);
      const rightJamb = new THREE.Mesh(jambGeo, this.materials.frameSteel);
      rightJamb.position.set(W + 0.032, (H + 0.06) * 0.5, 0);
      const topHeader = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(W + 0.13, 0.075, T + 0.065)),
        this.materials.frameSteel,
      );
      topHeader.position.set(W * 0.5, H + 0.038, 0);
      frameGroup.add(leftJamb, rightJamb, topHeader);
    }

    // Two heavy hinge barrels mounted on frame edge
    const hingeBarrelGeo = this.trackGeo(new THREE.CylinderGeometry(0.018, 0.018, 0.12, 8));
    for (const hy of [0.36, H - 0.36]) {
      const barrel = new THREE.Mesh(hingeBarrelGeo, this.materials.hingeIron);
      barrel.position.set(0.004, hy, spec.swingSign > 0 ? -T * 0.52 : T * 0.52);
      frameGroup.add(barrel);
    }

    // Frame-level repair interact proxy (only active when destroyed & repairable)
    const frameRepairProxy = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(W + 0.12, H, 0.34)),
      this.materials.proxyMat,
    );
    frameRepairProxy.position.set(W * 0.5, H * 0.5, 0);
    frameRepairProxy.visible = false;
    frameRepairProxy.userData.destructibleDoorId = spec.id;
    frameRepairProxy.userData.isRepairFrameProxy = true;
    frameGroup.add(frameRepairProxy);
    this.interactableMeshes.push(frameRepairProxy);

    // Hinged door pivot
    const hingePivot = new THREE.Group();
    hingePivot.name = `door_hinge_${spec.id}`;
    frameGroup.add(hingePivot);

    const slabContainer = new THREE.Group();
    hingePivot.add(slabContainer);

    const lowerHalfGroup = new THREE.Group();
    const upperHalfGroup = new THREE.Group();
    slabContainer.add(lowerHalfGroup, upperHalfGroup);

    const tagDoorMesh = (mesh: THREE.Mesh, isBreachCenter = false) => {
      mesh.castShadow = !this.isSoftwareGl;
      mesh.receiveShadow = true;
      mesh.userData.surfaceMaterial = 'wood';
      mesh.userData.destructibleDoorId = spec.id;
      mesh.userData.isDoorBreachPanel = isBreachCenter;
      this.raycastDoorMeshes.push(mesh);
      this.physics.addRaycastMesh(mesh);
    };

    // === LOWER HALF (y: 0 -> splitY) ===
    const lowerSlab = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(W - 0.01, splitY - 0.006, T)),
      slabMat,
    );
    lowerSlab.position.set(W * 0.5, splitY * 0.5, 0);
    lowerSlab.userData.doorPenetrableId = `door_${spec.id}_lower`;
    tagDoorMesh(lowerSlab);
    lowerHalfGroup.add(lowerSlab);
    this.penSystem.registerSurface({
      id: `door_${spec.id}_lower`,
      mesh: lowerSlab,
      kind: 'wood_door',
      width: W - 0.01,
      height: splitY - 0.006,
      thickness: T,
      floorY: spec.hingePos[1],
      maxHoles: 3,
      hitsToBreach: 1,
    });

    // Kick plate strip at bottom
    const kickPlate = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(W - 0.05, 0.18, T + 0.008)),
      this.materials.frameSteel,
    );
    kickPlate.position.set(W * 0.5, 0.11, 0);
    lowerHalfGroup.add(kickPlate);

    // Dual-sided brass/steel lever doorknob mounted at y = 0.96m on latch stile
    const knobX = W - 0.105;
    const knobY = Math.min(splitY - 0.09, 0.98);
    const rosetteGeo = this.trackGeo(new THREE.CylinderGeometry(0.032, 0.032, 0.016, 10));
    const stemGeo = this.trackGeo(new THREE.CylinderGeometry(0.012, 0.012, 0.048, 8));
    const leverGeo = this.trackGeo(new THREE.BoxGeometry(0.115, 0.022, 0.02));

    const buildHandleSide = (zSign: 1 | -1): THREE.Object3D => {
      const hGroup = new THREE.Group();
      hGroup.position.set(knobX, knobY, zSign * (T * 0.5));
      const ros = new THREE.Mesh(rosetteGeo, this.materials.brassHardware);
      ros.rotation.x = Math.PI * 0.5;
      ros.position.z = zSign * 0.008;
      const stem = new THREE.Mesh(stemGeo, this.materials.brassHardware);
      stem.rotation.x = Math.PI * 0.5;
      stem.position.z = zSign * 0.028;
      const lever = new THREE.Mesh(leverGeo, this.materials.brassHardware);
      lever.position.set(-0.046, 0, zSign * 0.054);
      hGroup.add(ros, stem, lever);
      const gripAnchor = new THREE.Object3D();
      gripAnchor.position.set(-0.042, 0, zSign * 0.062);
      hGroup.add(gripAnchor);
      lowerHalfGroup.add(hGroup);
      return gripAnchor;
    };
    const knobFront = buildHandleSide(1);
    const knobBack = buildHandleSide(-1);

    // Push anchors for fast left-hand Close push
    const pushPointFront = new THREE.Object3D();
    pushPointFront.position.set(W * 0.68, 1.18, T * 0.5 + 0.02);
    const pushPointBack = new THREE.Object3D();
    pushPointBack.position.set(W * 0.68, 1.18, -(T * 0.5 + 0.02));
    slabContainer.add(pushPointFront, pushPointBack);

    // === UPPER HALF (y: splitY -> H) — 4 Outer Framing Pieces + Removable Center Breach Panel ===
    const upperH = H - splitY;
    const leftStile = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(stileW, upperH, T)),
      slabMat,
    );
    leftStile.position.set(stileW * 0.5 + 0.004, splitY + upperH * 0.5, 0);
    tagDoorMesh(leftStile);

    const rightStile = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(stileW, upperH, T)),
      slabMat,
    );
    rightStile.position.set(W - stileW * 0.5 - 0.004, splitY + upperH * 0.5, 0);
    tagDoorMesh(rightStile);

    const topRail = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(holeW + 0.01, topRailH, T)),
      slabMat,
    );
    topRail.position.set(holeCenterX, H - topRailH * 0.5, 0);
    tagDoorMesh(topRail);

    const midBridgeRail = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(holeW + 0.01, 0.045, T)),
      slabMat,
    );
    midBridgeRail.position.set(holeCenterX, splitY + 0.022, 0);
    tagDoorMesh(midBridgeRail);

    // Removable Center Breach Panel (visible in States 0, 1, 2; hidden in State 3 to open real hole!)
    const centerBreachPanel = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(holeW + 0.006, holeH + 0.006, T * 0.92)),
      slabMat,
    );
    centerBreachPanel.position.set(holeCenterX, holeCenterY, 0);
    centerBreachPanel.userData.doorPenetrableId = `door_${spec.id}_upper`;
    tagDoorMesh(centerBreachPanel, true);
    this.penSystem.registerSurface({
      id: `door_${spec.id}_upper`,
      mesh: centerBreachPanel,
      kind: 'wood_door',
      width: holeW + 0.006,
      height: holeH + 0.006,
      thickness: T * 0.92,
      floorY: spec.hingePos[1],
      maxHoles: 4,
      hitsToBreach: 1,
    });

    upperHalfGroup.add(leftStile, rightStile, topRail, midBridgeRail, centerBreachPanel);

    // === STATE 1: DENTED / SPLINTERED OVERLAY ===
    const dentOverlays = new THREE.Group();
    dentOverlays.visible = false;
    for (const zSign of [-1, 1]) {
      const bruise = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.24, 0.2, 0.012)),
        this.materials.dentDark,
      );
      bruise.position.set(holeCenterX + 0.03, holeCenterY - 0.04, zSign * (T * 0.47));
      bruise.rotation.z = 0.24;
      dentOverlays.add(bruise);

      for (let s = 0; s < 3; s++) {
        const spl = new THREE.Mesh(
          this.trackGeo(new THREE.BoxGeometry(0.22, 0.026, 0.014)),
          this.materials.rawSplinterWood,
        );
        spl.position.set(
          holeCenterX + (s - 1) * 0.07,
          holeCenterY - 0.04 + (s - 1) * 0.055,
          zSign * (T * 0.485),
        );
        spl.rotation.z = (s - 1) * 0.35 + 0.15;
        dentOverlays.add(spl);
      }
    }
    upperHalfGroup.add(dentOverlays);

    // === STATE 2: CRACKED / PARTIAL HOLE OVERLAY ===
    const crackOverlays = new THREE.Group();
    crackOverlays.visible = false;
    for (const zSign of [-1, 1]) {
      const crack1 = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(holeW * 0.82, 0.045, 0.016)),
        this.materials.dentDark,
      );
      crack1.position.set(holeCenterX, holeCenterY + 0.03, zSign * (T * 0.49));
      crack1.rotation.z = 0.48;
      const crack2 = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(holeW * 0.72, 0.04, 0.016)),
        this.materials.dentDark,
      );
      crack2.position.set(holeCenterX - 0.03, holeCenterY - 0.05, zSign * (T * 0.49));
      crack2.rotation.z = -0.62;
      const coreGash = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.16, 0.28, 0.018)),
        this.materials.dentDark,
      );
      coreGash.position.set(holeCenterX, holeCenterY, zSign * (T * 0.495));
      coreGash.rotation.z = 0.12;
      crackOverlays.add(crack1, crack2, coreGash);

      for (let k = 0; k < 5; k++) {
        const shard = new THREE.Mesh(
          this.trackGeo(new THREE.BoxGeometry(0.18, 0.032, 0.018)),
          this.materials.rawSplinterWood,
        );
        shard.position.set(
          holeCenterX + Math.cos(k * 1.25) * 0.16,
          holeCenterY + Math.sin(k * 1.25) * 0.18,
          zSign * (T * 0.505),
        );
        shard.rotation.z = k * 0.85;
        crackOverlays.add(shard);
      }
    }
    upperHalfGroup.add(crackOverlays);

    // === STATE 3: JAGGED BREACHED SIGHTLINE SPLINTER RIM (real open shoot-through hole!) ===
    const breachSplinterRim = new THREE.Group();
    breachSplinterRim.visible = false;
    const jaggedCoords: Array<[number, number, number, number, number]> = [
      // [x, y, w, h, rotZ]
      [holeCenterX - holeW * 0.44, holeCenterY + holeH * 0.25, 0.11, 0.055, 0.22],
      [holeCenterX - holeW * 0.45, holeCenterY - holeH * 0.16, 0.13, 0.06, -0.3],
      [holeCenterX + holeW * 0.44, holeCenterY + holeH * 0.18, 0.12, 0.055, -0.25],
      [holeCenterX + holeW * 0.43, holeCenterY - holeH * 0.22, 0.14, 0.062, 0.34],
      [holeCenterX - 0.12, holeCenterY + holeH * 0.46, 0.075, 0.11, 0.18],
      [holeCenterX + 0.14, holeCenterY + holeH * 0.45, 0.08, 0.12, -0.22],
      [holeCenterX - 0.1, holeCenterY - holeH * 0.45, 0.09, 0.12, -0.15],
      [holeCenterX + 0.13, holeCenterY - holeH * 0.46, 0.085, 0.11, 0.28],
    ];
    for (const [jx, jy, jw, jh, jr] of jaggedCoords) {
      const tooth = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(jw, jh, T * 0.85)),
        this.materials.rawSplinterWood,
      );
      tooth.position.set(jx, jy, 0);
      tooth.rotation.z = jr;
      breachSplinterRim.add(tooth);
    }
    upperHalfGroup.add(breachSplinterRim);

    // === OUTCOME B SPLIT SEAM SPLINTER CAPS (hidden until door splits in half) ===
    const splitEdgeLower = new THREE.Group();
    const splitEdgeUpper = new THREE.Group();
    splitEdgeLower.visible = false;
    splitEdgeUpper.visible = false;
    for (let i = 0; i < 6; i++) {
      const sx = 0.12 + (i / 5) * (W - 0.24);
      const tLow = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.14, 0.065, T * 0.92)),
        this.materials.rawSplinterWood,
      );
      tLow.position.set(sx, splitY + 0.012, 0);
      tLow.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.28;
      splitEdgeLower.add(tLow);

      const tUp = new THREE.Mesh(
        this.trackGeo(new THREE.BoxGeometry(0.14, 0.065, T * 0.92)),
        this.materials.rawSplinterWood,
      );
      tUp.position.set(sx, splitY - 0.012, 0);
      tUp.rotation.z = (i % 2 === 0 ? -1 : 1) * 0.26;
      splitEdgeUpper.add(tUp);
    }
    lowerHalfGroup.add(splitEdgeLower);
    upperHalfGroup.add(splitEdgeUpper);

    // Interact proxy attached to hinged slab (moves smoothly with door angle!)
    const interactProxy = new THREE.Mesh(
      this.trackGeo(new THREE.BoxGeometry(W + 0.08, H, T + 0.24)),
      this.materials.proxyMat,
    );
    interactProxy.position.set(W * 0.5, H * 0.5, 0);
    interactProxy.userData.destructibleDoorId = spec.id;
    slabContainer.add(interactProxy);
    this.interactableMeshes.push(interactProxy);

    // Dynamic oriented slab collider registered in BodycamPhysicsWorld
    const initDirX = Math.cos(spec.closedYawRad);
    const initDirZ = -Math.sin(spec.closedYawRad);
    const dynamicSlab: PhysicsDynamicSlab = {
      id: `door_slab_${spec.id}`,
      originX: spec.hingePos[0],
      originZ: spec.hingePos[2],
      minY: spec.hingePos[1],
      maxY: spec.hingePos[1] + H,
      dirX: initDirX,
      dirZ: initDirZ,
      length: W,
      halfThickness: T * 0.5 + 0.02,
      active: true,
      rigidBlocked: true,
    };

    const runtime: DestructibleDoorRuntime = {
      id: spec.id,
      label: spec.label,
      spec,
      frameGroup,
      hingePivot,
      slabContainer,
      lowerHalfGroup,
      upperHalfGroup,
      centerBreachPanel,
      dentOverlays,
      crackOverlays,
      breachSplinterRim,
      splitEdgeLower,
      splitEdgeUpper,
      knobFront,
      knobBack,
      pushPointFront,
      pushPointBack,
      interactProxy,
      frameRepairProxy,
      dynamicSlab,
      angleRad: 0,
      angularVel: 0,
      latched: true,
      softClosing: false,
      damageState: 0,
      chipDamage: 0,
      hingeMode: 'attached',
      destructionOutcome: 'none',
      destructionSeed: 0,
      splitCollapseTimerSec: 0,
      nudgeBroadcastCooldown: 0,
      jambShudderTimer: 0,
      kickCooldownTimer: 0,
      lastKickDir: new THREE.Vector3(0, 0, -1),
      shearedBody: {
        group: slabContainer,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        floorY: spec.hingePos[1],
        halfThickness: T * 0.5,
        layFlatPitchSign: 1,
        active: false,
        settled: false,
        bounced: false,
      },
      upperSplitBody: {
        group: upperHalfGroup,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        floorY: spec.hingePos[1],
        halfThickness: T * 0.5,
        layFlatPitchSign: 1,
        active: false,
        settled: false,
        bounced: false,
      },
      lowerSplitBody: {
        group: lowerHalfGroup,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        floorY: spec.hingePos[1],
        halfThickness: T * 0.5,
        layFlatPitchSign: 1,
        active: false,
        settled: false,
        bounced: false,
      },
    };

    // Wire physical capsule body-bump nudge torque when unlatched!
    dynamicSlab.onCapsulePush = (contactDist, pushNX, pushNZ, pen, moveDX, moveDZ) => {
      if (runtime.latched || runtime.hingeMode !== 'attached') return;
      const worldYaw = runtime.spec.closedYawRad + runtime.angleRad;
      // Unit tangent along increasing angleRad: d/dθ (cos θ, -sin θ) = (-sin θ, -cos θ)
      const tanX = -Math.sin(worldYaw);
      const tanZ = -Math.cos(worldYaw);
      // Combine incoming walk velocity & normal penetration push
      const moveDot = moveDX * tanX + moveDZ * tanZ;
      const normDot = pushNX * tanX + pushNZ * tanZ;
      const pushDrive = moveDot * 52 + normDot * Math.min(0.18, pen) * 28;
      if (Math.abs(pushDrive) < 0.05) return;

      const lever = THREE.MathUtils.clamp(contactDist / Math.max(0.2, runtime.spec.width), 0.28, 1.0);
      runtime.softClosing = false;
      runtime.angularVel = THREE.MathUtils.clamp(
        runtime.angularVel + pushDrive * lever * 0.36,
        -7.2,
        7.2,
      );
      if (runtime.nudgeBroadcastCooldown <= 0) {
        runtime.nudgeBroadcastCooldown = 0.16;
        this.emitBroadcast(runtime, 'nudge');
      }
    };

    this.physics.addDynamicSlab(dynamicSlab);
    this.doors.set(spec.id, runtime);
    this.doorList.push(runtime);
    return runtime;
  }

  /**
   * Computes dot product between a horizontal world direction and the door's legal open swing normal.
   * >= 0 means pushing/kicking WITH the door's swing direction; < 0 means AGAINST the hinge/jamb stop.
   */
  private getSwingAlignmentDot(d: DestructibleDoorRuntime, dirX: number, dirZ: number): number {
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-4) return 1;
    const nx = dirX / len;
    const nz = dirZ / len;
    const worldYaw = d.spec.closedYawRad + d.angleRad;
    // Unit tangent along increasing angleRad is (-sin(worldYaw), -cos(worldYaw)); multiply by swingSign for open side
    const openNX = -Math.sin(worldYaw) * d.spec.swingSign;
    const openNZ = -Math.cos(worldYaw) * d.spec.swingSign;
    return nx * openNX + nz * openNZ;
  }

  /** Returns true if actorPos stands on the push/swing-with side of the door (kicking opens away from actor) */
  public isActorOnSwingWithSide(doorId: string, actorPos: Readonly<THREE.Vector3>): boolean {
    const d = this.doors.get(doorId);
    if (!d) return true;
    const worldYaw = d.spec.closedYawRad + d.angleRad;
    const cx = d.spec.hingePos[0] + Math.cos(worldYaw) * (d.spec.width * 0.5);
    const cz = d.spec.hingePos[2] - Math.sin(worldYaw) * (d.spec.width * 0.5);
    return this.getSwingAlignmentDot(d, cx - actorPos.x, cz - actorPos.z) >= -0.05;
  }

  /** Computes the ordered multi-option [F] scroll actions for a door (side-aware Kick hint) */
  public getInteractOptions(
    doorId: string,
    isSprinting = false,
    horizontalSpeedMps = 0,
    actorPos?: Readonly<THREE.Vector3>,
  ): DoorInteractOption[] {
    const d = this.doors.get(doorId);
    if (!d) return [];

    if (d.hingeMode !== 'attached') {
      return d.spec.repairable ? [{ id: 'repair', label: 'Repair Door', hint: 'Hold [F]' }] : [];
    }

    const damagedRepairable =
      d.spec.repairable && (d.damageState > 0 || d.chipDamage >= 12);

    if (d.latched) {
      const smash = isSprinting || horizontalSpeedMps >= SPRINT_DESTROY_SPEED_MPS;
      const withSwing = actorPos ? this.isActorOnSwingWithSide(doorId, actorPos) : true;
      let kickHint: string;
      if (withSwing) {
        kickHint = smash ? 'Smash' : 'Breach';
      } else if (d.damageState < 3) {
        kickHint = smash ? 'Smash Hole' : 'Break Panel';
      } else {
        kickHint = smash ? 'Shatter' : 'Rattle Frame';
      }
      const opts: DoorInteractOption[] = [
        { id: 'open', label: 'Open' },
        { id: 'peek', label: 'Peek', hint: 'Quiet' },
        { id: 'kick', label: 'Kick', hint: kickHint },
      ];
      if (damagedRepairable) {
        opts.push({ id: 'repair', label: 'Repair Door', hint: 'Hold [F]' });
      }
      return opts;
    }

    // Door is open / unlatched: Close (fast push), Close (Soft doorknob), plus Open ONLY if not already fully open
    const openRatio = Math.abs(d.angleRad) / Math.max(0.1, d.spec.maxOpenRad);
    const opts: DoorInteractOption[] = [
      { id: 'close', label: 'Close' },
      { id: 'close_soft', label: 'Close (Soft)', hint: 'Quiet' },
    ];
    if (openRatio < 0.82) {
      opts.push({ id: 'open', label: 'Open' });
    }
    if (damagedRepairable) {
      opts.push({ id: 'repair', label: 'Repair Door', hint: 'Hold [F]' });
    }
    return opts;
  }

  public isDoorNeedsRepair(doorId: string): boolean {
    const d = this.doors.get(doorId);
    if (!d || !d.spec.repairable) return false;
    return d.hingeMode !== 'attached' || d.damageState > 0 || d.chipDamage >= 12;
  }

  public getRepairAnchorWorldPos(doorId: string, outPos: THREE.Vector3): boolean {
    const d = this.doors.get(doorId);
    if (!d) return false;
    const worldYaw = d.spec.closedYawRad + (d.hingeMode === 'attached' ? d.angleRad : 0);
    outPos.set(
      d.spec.hingePos[0] + Math.cos(worldYaw) * (d.spec.width * 0.42),
      d.spec.hingePos[1] + Math.min(1.28, d.spec.height * 0.56),
      d.spec.hingePos[2] - Math.sin(worldYaw) * (d.spec.width * 0.42),
    );
    return true;
  }

  public playRepairWorkTick(doorId: string): void {
    const d = this.doors.get(doorId);
    if (!d) return;
    const centerPos = this._tmpV3;
    this.getRepairAnchorWorldPos(doorId, centerPos);
    const distM = centerPos.distanceTo(this.listenerPos);
    this.synth.play(d.spec.style === 'tactical_reinforced' ? 'latch_soft' : 'repair', distM);
  }

  /** Returns the world position of the doorknob facing the actor (for 1P/3P IK) */
  public getDoorknobWorldPos(
    doorId: string,
    actorPos: Readonly<THREE.Vector3>,
    outPos: THREE.Vector3,
  ): boolean {
    const d = this.doors.get(doorId);
    if (!d || d.hingeMode !== 'attached') return false;
    d.hingePivot.updateMatrixWorld(true);
    d.knobFront.getWorldPosition(this._tmpV1);
    d.knobBack.getWorldPosition(this._tmpV2);
    if (this._tmpV1.distanceToSquared(actorPos) <= this._tmpV2.distanceToSquared(actorPos)) {
      outPos.copy(this._tmpV1);
    } else {
      outPos.copy(this._tmpV2);
    }
    return true;
  }

  /** Returns the world position on the door face facing the actor (for fast left-hand push) */
  public getPushFaceWorldPos(
    doorId: string,
    actorPos: Readonly<THREE.Vector3>,
    outPos: THREE.Vector3,
  ): boolean {
    const d = this.doors.get(doorId);
    if (!d || d.hingeMode !== 'attached') return false;
    d.hingePivot.updateMatrixWorld(true);
    d.pushPointFront.getWorldPosition(this._tmpV1);
    d.pushPointBack.getWorldPosition(this._tmpV2);
    if (this._tmpV1.distanceToSquared(actorPos) <= this._tmpV2.distanceToSquared(actorPos)) {
      outPos.copy(this._tmpV1);
    } else {
      outPos.copy(this._tmpV2);
    }
    return true;
  }

  public getDoorCenterWorldPos(doorId: string, outPos: THREE.Vector3): boolean {
    const d = this.doors.get(doorId);
    if (!d) return false;
    const worldYaw = d.spec.closedYawRad + d.angleRad;
    outPos.set(
      d.spec.hingePos[0] + Math.cos(worldYaw) * (d.spec.width * 0.5),
      d.spec.hingePos[1] + d.spec.height * 0.5,
      d.spec.hingePos[2] - Math.sin(worldYaw) * (d.spec.width * 0.5),
    );
    return true;
  }

  /** Executes a player or AI interaction option on a door */
  public executeOption(
    doorId: string,
    optionId: DoorInteractOptionId,
    opts?: {
      actorPos?: Readonly<THREE.Vector3>;
      actorForward?: Readonly<THREE.Vector3>;
      horizontalSpeedMps?: number;
      isSprinting?: boolean;
      actorTeam?: 'A' | 'B' | 'FFA';
      fromRemote?: boolean;
      seed?: number;
    },
  ): boolean {
    const d = this.doors.get(doorId);
    if (!d) return false;

    const fromRemote = Boolean(opts?.fromRemote);
    const centerPos = this._tmpV3;
    this.getDoorCenterWorldPos(doorId, centerPos);
    const distM = centerPos.distanceTo(this.listenerPos);

    if (optionId === 'repair') {
      if (!d.spec.repairable && !fromRemote) return false;
      this.repairDoor(d, fromRemote);
      return true;
    }

    if (d.hingeMode !== 'attached') return false;

    if (optionId === 'open') {
      const wasLatched = d.latched;
      d.latched = false;
      d.softClosing = false;
      d.dynamicSlab.rigidBlocked = false;
      d.angularVel = d.spec.swingSign * (wasLatched ? 4.4 : 3.8);
      this.synth.play('knob_turn', distM);
      this.emitAcoustic(d, centerPos, 7.5, 0.45, 'knob_turn', opts?.actorTeam);
      if (!fromRemote) this.emitBroadcast(d, 'open');
      return true;
    }

    if (optionId === 'peek') {
      d.latched = false;
      d.softClosing = false;
      d.dynamicSlab.rigidBlocked = false;
      // Gentle impulse that opens ~24° quietly & leaves door unlatched for body-nudging
      d.angularVel = d.spec.swingSign * 1.52;
      this.synth.play('knob_turn', distM);
      this.emitAcoustic(d, centerPos, 2.6, 0.14, 'knob_turn', opts?.actorTeam);
      if (!fromRemote) this.emitBroadcast(d, 'peek');
      return true;
    }

    if (optionId === 'close') {
      d.latched = false;
      d.softClosing = false;
      d.dynamicSlab.rigidBlocked = false;
      d.angularVel = -d.spec.swingSign * 5.6;
      if (!fromRemote) this.emitBroadcast(d, 'close');
      return true;
    }

    if (optionId === 'close_soft') {
      d.latched = false;
      d.softClosing = true;
      d.dynamicSlab.rigidBlocked = false;
      d.angularVel = -d.spec.swingSign * 1.95;
      this.synth.play('knob_turn', distM);
      if (!fromRemote) this.emitBroadcast(d, 'close_soft');
      return true;
    }

    if (optionId === 'kick') {
      return this.executeKick(
        doorId,
        opts?.actorForward ?? this._tmpV1.set(0, 0, -1),
        opts?.horizontalSpeedMps ?? 0,
        Boolean(opts?.isSprinting),
        opts?.actorTeam,
        fromRemote,
        opts?.seed,
      );
    }

    return false;
  }

  /**
   * Directional Velocity-Based Kick Breaching:
   *  - Kicking WITH the hinge swing direction:
   *      • Standing / Walking -> Standard Breach Kick (slams open on hinges, stays intact)
   *      • Sprinting -> Destructive Kick (Outcome A: Hinge Shear launch, or Outcome B: Split & Collapse)
   *  - Kicking AGAINST the hinge/jamb stop:
   *      • If already open (> 14%) -> Slams the open door SHUT back into its jamb
   *      • If closed against jamb stop (never swings toward kicker!):
   *          - State 0..2 + Walking -> Advances progressive hole damage (+1 stage)
   *          - State 0..2 + Sprinting -> Punches straight through to State 3 (Breached Sightline)
   *          - State 3 (already breached) + Walking -> Rattles frame with splinters
   *          - State 3 (already breached) + Sprinting -> Shatters weakened door off hinges away from boot
   */
  public executeKick(
    doorId: string,
    kickDir: Readonly<THREE.Vector3>,
    horizontalSpeedMps: number,
    isSprinting: boolean,
    actorTeam?: 'A' | 'B' | 'FFA',
    fromRemote = false,
    explicitSeed?: number,
    impactPoint?: Readonly<THREE.Vector3>,
    hitObject?: THREE.Object3D | null,
  ): boolean {
    const d = this.doors.get(doorId);
    if (!d || d.hingeMode !== 'attached') return false;
    if (!fromRemote && d.kickCooldownTimer > 0) return false;
    if (!fromRemote) d.kickCooldownTimer = 0.32;

    const centerPos = this._tmpV3;
    this.getDoorCenterWorldPos(doorId, centerPos);
    const hitPos = impactPoint ?? centerPos;
    const distM = centerPos.distanceTo(this.listenerPos);
    const isDestructive = isSprinting || horizontalSpeedMps >= SPRINT_DESTROY_SPEED_MPS;
    const swingDot = this.getSwingAlignmentDot(d, kickDir.x, kickDir.z);
    const openRatio = Math.abs(d.angleRad) / Math.max(0.1, d.spec.maxOpenRad);

    // === AGAINST-HINGE DIRECTIONAL KICK ===
    if (swingDot < -0.05) {
      // If the door is already unlatched & open past 14%, kicking from the back slams it SHUT cleanly
      if (!d.latched && openRatio >= 0.14) {
        d.softClosing = false;
        d.angularVel = -d.spec.swingSign * 9.8;
        this.spawnBurst(hitPos, kickDir, 4, d.spec.hingePos[1], false);
        this.synth.play('kick_breach', distM);
        this.emitAcoustic(d, centerPos, 18.0, 0.8, 'kick_breach', actorTeam);
        if (!fromRemote) {
          this.emitBroadcast(d, 'close', hitPos, kickDir);
        }
        return true;
      }

      // Closed / braced against jamb stop: NEVER opens toward the kicker!
      // Carve a real boot-shaped see-through, shoot-through hole where the boot struck!
      d.angleRad = 0;
      d.angularVel = 0;
      d.latched = true;
      d.softClosing = false;
      d.dynamicSlab.rigidBlocked = true;
      d.hingePivot.rotation.y = 0;
      d.jambShudderTimer = 0.18;

      if (d.damageState < 3) {
        const nextState: DoorDamageState = isDestructive
          ? 3
          : ((d.damageState + 1) as DoorDamageState);

        const targetPenId =
          typeof hitObject?.userData?.doorPenetrableId === 'string'
            ? hitObject.userData.doorPenetrableId
            : hitPos.y < d.spec.hingePos[1] + d.spec.height * 0.48
              ? `door_${d.id}_lower`
              : `door_${d.id}_upper`;
        this.penSystem.applyMeleeImpact(targetPenId, hitPos, kickDir, 'kick', explicitSeed);

        // Keep centerBreachPanel visible so the real carved boot hole stays rendered!
        if (nextState < 3) {
          this.setDamageStateVisuals(d, nextState);
        } else {
          d.damageState = 3;
          d.dentOverlays.visible = false;
          d.crackOverlays.visible = false;
          d.breachSplinterRim.visible = false;
          d.centerBreachPanel.visible = true;
        }
        d.chipDamage = 0;

        const cue: DoorAudioCueKind =
          nextState === 3 ? 'wood_breach' : nextState === 2 ? 'wood_crack' : 'wood_dent';
        this.spawnBurst(
          hitPos,
          kickDir,
          nextState === 3 ? 20 : 12,
          d.spec.hingePos[1],
          false,
        );
        this.synth.play(cue, distM);
        this.emitAcoustic(
          d,
          hitPos,
          nextState === 3 ? 24.0 : 16.0,
          nextState === 3 ? 0.92 : 0.76,
          cue,
          actorTeam,
        );
        if (!fromRemote) {
          this.emitBroadcast(d, 'melee_bash', hitPos, kickDir);
        }
        return true;
      }

      // Already breached (State 3): sprinting kick shatters weakened door off hinges away from boot
      if (isDestructive) {
        const seed =
          typeof explicitSeed === 'number'
            ? explicitSeed
            : Math.floor(Math.random() * 100000);
        d.destructionSeed = seed;
        const outcome: DoorDestructionOutcome =
          seed % 2 === 0 ? 'hinge_shear' : 'split_collapse';
        this.applyDestructiveKickOutcome(d, outcome, kickDir, seed, actorTeam, fromRemote, true);
        return true;
      }

      // Walking kick on already-breached frame: enlarge/carve another hole at impact point + shudder
      const targetPenId =
        typeof hitObject?.userData?.doorPenetrableId === 'string'
          ? hitObject.userData.doorPenetrableId
          : hitPos.y < d.spec.hingePos[1] + d.spec.height * 0.48
            ? `door_${d.id}_lower`
            : `door_${d.id}_upper`;
      this.penSystem.applyMeleeImpact(targetPenId, hitPos, kickDir, 'kick', explicitSeed);
      this.spawnBurst(hitPos, kickDir, 8, d.spec.hingePos[1], false);
      this.synth.play('wood_dent', distM);
      this.emitAcoustic(d, hitPos, 12.0, 0.58, 'wood_dent', actorTeam);
      return true;
    }

    // === WITH-HINGE DIRECTIONAL KICK ===
    if (!isDestructive) {
      // Standard Breach Kick: violently slams door open on hinges, stays attached & intact
      d.latched = false;
      d.softClosing = false;
      d.dynamicSlab.rigidBlocked = false;
      d.angularVel = d.spec.swingSign * 11.8;
      this.spawnBurst(centerPos, kickDir, 6, d.spec.hingePos[1], false);
      this.synth.play('kick_breach', distM);
      this.emitAcoustic(d, centerPos, 24.0, 0.92, 'kick_breach', actorTeam);
      if (!fromRemote) {
        this.emitBroadcast(d, 'kick_breach', centerPos, kickDir);
      }
      return true;
    }

    // Sprinting Destructive Kick: deterministic Outcome A (Hinge Shear) or Outcome B (Split & Collapse)
    const seed =
      typeof explicitSeed === 'number'
        ? explicitSeed
        : Math.floor(Math.random() * 100000);
    d.destructionSeed = seed;
    const outcome: DoorDestructionOutcome =
      seed % 2 === 0 ? 'hinge_shear' : 'split_collapse';
    this.applyDestructiveKickOutcome(d, outcome, kickDir, seed, actorTeam, fromRemote, false);
    return true;
  }

  /**
   * Determines whether pitching the detached door group around its local X axis by +π/2 or -π/2
   * lays the top edge (+Y) forward along launchDir (away from the kicker).
   */
  private computeLayFlatPitchSign(
    group: THREE.Group,
    launchDir: Readonly<THREE.Vector3>,
  ): 1 | -1 {
    this._tmpFaceNormal.set(0, 0, 1).applyQuaternion(group.quaternion);
    const align = this._tmpFaceNormal.x * launchDir.x + this._tmpFaceNormal.z * launchDir.z;
    return align >= 0 ? 1 : -1;
  }

  private applyDestructiveKickOutcome(
    d: DestructibleDoorRuntime,
    outcome: DoorDestructionOutcome,
    kickDir: Readonly<THREE.Vector3>,
    seed: number,
    actorTeam?: 'A' | 'B' | 'FFA',
    fromRemote = false,
    forceAwayFromKicker = false,
  ): void {
    const centerPos = this._tmpV3;
    this.getDoorCenterWorldPos(d.id, centerPos);
    const distM = centerPos.distanceTo(this.listenerPos);

    d.latched = false;
    d.softClosing = false;
    d.jambShudderTimer = 0;
    d.slabContainer.position.z = 0;
    d.destructionOutcome = outcome;
    d.destructionSeed = seed;
    d.dynamicSlab.active = false;
    d.interactProxy.visible = false;
    d.frameRepairProxy.visible = d.spec.repairable;

    // Isolated normalized horizontal launch vector strictly along the kicker's aim direction
    // (never aliased with _tmpV1/_tmpV2 which detachGroupToWorld mutates)
    const fwd = this._tmpLaunchDir.set(kickDir.x, 0, kickDir.z);
    if (fwd.lengthSq() < 0.01) {
      const wYaw = d.spec.closedYawRad + d.angleRad;
      fwd.set(-Math.sin(wYaw) * d.spec.swingSign, 0, -Math.cos(wYaw) * d.spec.swingSign);
    } else {
      fwd.normalize();
    }
    d.lastKickDir.copy(fwd);
    const aimLift = THREE.MathUtils.clamp(kickDir.y, -0.55, 0.45) * 1.35;

    if (outcome === 'hinge_shear') {
      // Outcome A: All hinges detach immediately; slab launches along kick aim & lands flat forward
      d.hingeMode = 'sheared_flying';
      d.hingePivot.updateMatrixWorld(true);
      this.detachGroupToWorld(d.slabContainer, d.shearedBody);

      const pitchSign = this.computeLayFlatPitchSign(d.slabContainer, fwd);
      const yawCross = this._tmpFaceNormal.z * fwd.x - this._tmpFaceNormal.x * fwd.z;
      d.shearedBody.layFlatPitchSign = pitchSign;
      d.shearedBody.vel.set(fwd.x * 5.6, Math.max(0.55, 1.55 + aimLift), fwd.z * 5.6);
      d.shearedBody.angVel.set(
        pitchSign * 4.5,
        yawCross * 1.35 + ((seed % 7) - 3) * 0.28,
        ((seed % 5) - 2) * 0.16,
      );

      // Metallic sparks at hinges + splinter burst strictly along kick aim
      this._tmpV2.set(d.spec.hingePos[0], d.spec.hingePos[1] + 1.2, d.spec.hingePos[2]);
      this.spawnBurst(this._tmpV2, fwd, 10, d.spec.hingePos[1], true);
      this.spawnBurst(centerPos, fwd, 14, d.spec.hingePos[1], false);
      this.synth.play('hinge_shear', distM);
      this.emitAcoustic(d, centerPos, 30.0, 1.0, 'hinge_shear', actorTeam);
    } else if (forceAwayFromKicker) {
      // Against-hinge weakened shatter (Outcome B): split & blast both halves forward along kick aim
      d.hingeMode = 'collapsed';
      d.splitEdgeLower.visible = true;
      d.splitEdgeUpper.visible = true;
      d.hingePivot.updateMatrixWorld(true);
      this.detachGroupToWorld(d.upperHalfGroup, d.upperSplitBody);
      this.detachGroupToWorld(d.lowerHalfGroup, d.lowerSplitBody);

      const pitchSignUp = this.computeLayFlatPitchSign(d.upperHalfGroup, fwd);
      const pitchSignLow = this.computeLayFlatPitchSign(d.lowerHalfGroup, fwd);
      const sideX = -fwd.z;
      const sideZ = fwd.x;

      d.upperSplitBody.layFlatPitchSign = pitchSignUp;
      d.upperSplitBody.vel.set(
        fwd.x * 4.9 + sideX * 0.45,
        Math.max(0.65, 1.55 + aimLift),
        fwd.z * 4.9 + sideZ * 0.45,
      );
      d.upperSplitBody.angVel.set(pitchSignUp * 4.9, 1.45, -0.65);

      d.lowerSplitBody.layFlatPitchSign = pitchSignLow;
      d.lowerSplitBody.vel.set(
        fwd.x * 3.7 - sideX * 0.3,
        Math.max(0.35, 0.95 + aimLift * 0.55),
        fwd.z * 3.7 - sideZ * 0.3,
      );
      d.lowerSplitBody.angVel.set(pitchSignLow * 3.4, -0.85, 0.45);

      this._tmpV2.set(d.spec.hingePos[0], d.spec.hingePos[1] + 1.2, d.spec.hingePos[2]);
      this.spawnBurst(this._tmpV2, fwd, 10, d.spec.hingePos[1], true);
      this.spawnBurst(centerPos, fwd, 20, d.spec.hingePos[1], false);
      this.synth.play('wood_split', distM);
      this.synth.play('hinge_shear', distM);
      this.emitAcoustic(d, centerPos, 30.0, 1.0, 'wood_split', actorTeam);
    } else {
      // Outcome B (with-hinge): Slams open violently on hinges AND splits into two halves; after 0.55–0.95s hinges fail & pieces fall
      d.hingeMode = 'splitting';
      d.angularVel = d.spec.swingSign * 13.6;
      d.splitCollapseTimerSec = 0.55 + ((seed % 41) / 40) * 0.4; // 0.55s .. 0.95s
      d.splitEdgeLower.visible = true;
      d.splitEdgeUpper.visible = true;
      // Diagonal split crack offset immediately visible during hinge slam
      d.upperHalfGroup.rotation.z = -0.14;
      d.upperHalfGroup.position.set(0.03, 0.03, 0.02);
      d.lowerHalfGroup.rotation.z = 0.06;

      this.spawnBurst(centerPos, fwd, 18, d.spec.hingePos[1], false);
      this.synth.play('wood_split', distM);
      this.emitAcoustic(d, centerPos, 30.0, 1.0, 'wood_split', actorTeam);
    }

    if (!fromRemote) {
      this.emitBroadcast(d, 'kick_destroy', centerPos, fwd);
    }
  }

  private detachGroupToWorld(group: THREE.Group, body: DebrisBodyState): void {
    group.updateMatrixWorld(true);
    group.getWorldPosition(this._tmpV1);
    group.getWorldQuaternion(this._tmpQ1);
    this.root.add(group);
    group.position.copy(this._tmpV1);
    group.quaternion.copy(this._tmpQ1);
    body.pos.copy(this._tmpV1);
    body.active = true;
    body.settled = false;
    body.bounced = false;
  }

  private collapseSplitHalves(d: DestructibleDoorRuntime): void {
    if (d.hingeMode !== 'splitting') return;
    d.hingeMode = 'collapsed';
    const centerPos = this._tmpV3;
    this.getDoorCenterWorldPos(d.id, centerPos);
    const distM = centerPos.distanceTo(this.listenerPos);

    const wYaw = d.spec.closedYawRad + d.angleRad;
    const swingOutX = -Math.sin(wYaw) * d.spec.swingSign;
    const swingOutZ = -Math.cos(wYaw) * d.spec.swingSign;

    // Blend current open-swing tangent with original kick aim direction so halves collapse forward naturally
    const fallDir = this._tmpLaunchDir.set(
      swingOutX * 0.62 + d.lastKickDir.x * 0.38,
      0,
      swingOutZ * 0.62 + d.lastKickDir.z * 0.38,
    );
    if (fallDir.lengthSq() < 0.01) {
      fallDir.set(swingOutX, 0, swingOutZ);
    } else {
      fallDir.normalize();
    }
    const sideX = -fallDir.z;
    const sideZ = fallDir.x;

    this.detachGroupToWorld(d.upperHalfGroup, d.upperSplitBody);
    this.detachGroupToWorld(d.lowerHalfGroup, d.lowerSplitBody);

    const pitchSignUp = this.computeLayFlatPitchSign(d.upperHalfGroup, fallDir);
    const pitchSignLow = this.computeLayFlatPitchSign(d.lowerHalfGroup, fallDir);

    d.upperSplitBody.layFlatPitchSign = pitchSignUp;
    d.upperSplitBody.vel.set(fallDir.x * 2.3 + sideX * 0.35, 0.75, fallDir.z * 2.3 + sideZ * 0.35);
    d.upperSplitBody.angVel.set(pitchSignUp * 3.6, 1.15, -0.55);

    d.lowerSplitBody.layFlatPitchSign = pitchSignLow;
    d.lowerSplitBody.vel.set(fallDir.x * 1.4 - sideX * 0.22, 0.35, fallDir.z * 1.4 - sideZ * 0.22);
    d.lowerSplitBody.angVel.set(pitchSignLow * 2.4, -0.7, 0.35);

    this._tmpV1.set(d.spec.hingePos[0], d.spec.hingePos[1] + 1.2, d.spec.hingePos[2]);
    this._tmpV2.set(fallDir.x, 0.3, fallDir.z);
    this.spawnBurst(this._tmpV1, this._tmpV2, 8, d.spec.hingePos[1], true);
    this.synth.play('hinge_shear', distM);
  }

  /**
   * Progressive Melee Hit (Rifle stock bash / melee strike):
   *  Hit 1 -> State 1 (Dented)
   *  Hit 2 -> State 2 (Cracked / Partial Hole)
   *  Hit 3 -> State 3 (Breached Sightline — removes center panel so you can see & shoot through!)
   */
  public applyMeleeBash(
    doorId: string,
    impactPoint: Readonly<THREE.Vector3>,
    direction: Readonly<THREE.Vector3>,
    actorTeam?: 'A' | 'B' | 'FFA',
    fromRemote = false,
    hitObject?: THREE.Object3D | null,
    attackType: 'jab' | 'cross' | 'bash' | 'kick' | 'knife_slash' | 'knife_stab' = 'bash',
  ): DoorDamageState | null {
    const d = this.doors.get(doorId);
    if (!d || d.hingeMode !== 'attached') return null;

    const distM = impactPoint.distanceTo(this.listenerPos);
    // Subtle physical shudder impulse on hinge if unlatched
    if (!d.latched) {
      d.angularVel += d.spec.swingSign * 1.65;
    }

    // Carve an actual see-through, shoot-through hole directly at the fist/buttstock impact point!
    const targetPenId =
      typeof hitObject?.userData?.doorPenetrableId === 'string'
        ? hitObject.userData.doorPenetrableId
        : impactPoint.y < d.spec.hingePos[1] + d.spec.height * 0.48
          ? `door_${d.id}_lower`
          : `door_${d.id}_upper`;
    this.penSystem.applyMeleeImpact(targetPenId, impactPoint, direction, attackType);

    if (d.damageState < 3) {
      const nextState = (d.damageState + 1) as DoorDamageState;
      d.damageState = nextState;
      d.dentOverlays.visible = false;
      d.crackOverlays.visible = false;
      d.breachSplinterRim.visible = false;
      d.centerBreachPanel.visible = true;
      d.chipDamage = 0;

      const cue: DoorAudioCueKind =
        nextState === 1 ? 'wood_dent' : nextState === 2 ? 'wood_crack' : 'wood_breach';
      this.spawnBurst(impactPoint, direction, nextState === 3 ? 16 : 11, d.spec.hingePos[1], false);
      this.synth.play(cue, distM);
      this.emitAcoustic(d, impactPoint, nextState === 3 ? 20 : 14, 0.78, cue, actorTeam);

      if (!fromRemote) {
        this.emitBroadcast(d, 'melee_bash', impactPoint, direction);
      }
      return nextState;
    }

    // Already at State 3: minor wood thud + extra hole widening at impact spot
    this.spawnBurst(impactPoint, direction, 6, d.spec.hingePos[1], false);
    this.synth.play('wood_dent', distM);
    if (!fromRemote) {
      this.emitBroadcast(d, 'melee_bash', impactPoint, direction);
    }
    return 3;
  }

  /**
   * Gunfire Wood Chipping:
   * Bullets chip splinters and accumulate damage toward advancing progressive damage states (0->1->2->3).
   */
  public applyBulletImpact(
    doorId: string,
    impactPoint: Readonly<THREE.Vector3>,
    direction: Readonly<THREE.Vector3>,
    damageAmount: number,
    actorTeam?: 'A' | 'B' | 'FFA',
    fromRemote = false,
  ): boolean {
    const d = this.doors.get(doorId);
    if (!d || d.hingeMode !== 'attached') return false;

    const distM = impactPoint.distanceTo(this.listenerPos);
    this.spawnBurst(impactPoint, direction, 5, d.spec.hingePos[1], false);

    if (!d.latched) {
      d.angularVel += d.spec.swingSign * 0.35;
    }

    if (d.damageState < 3) {
      d.chipDamage += Math.max(12, damageAmount);
      if (d.chipDamage >= CHIP_DAMAGE_PER_STAGE) {
        d.chipDamage -= CHIP_DAMAGE_PER_STAGE;
        const nextState = (d.damageState + 1) as DoorDamageState;
        this.setDamageStateVisuals(d, nextState);
        const cue: DoorAudioCueKind =
          nextState === 1 ? 'wood_dent' : nextState === 2 ? 'wood_crack' : 'wood_breach';
        this.spawnBurst(impactPoint, direction, nextState === 3 ? 14 : 8, d.spec.hingePos[1], false);
        this.synth.play(cue, distM);
        this.emitAcoustic(d, impactPoint, 16, 0.7, cue, actorTeam);
      }
      if (!fromRemote) {
        this.emitBroadcast(d, 'bullet_chip', impactPoint, direction);
      }
    }
    return true;
  }

  private setDamageStateVisuals(d: DestructibleDoorRuntime, state: DoorDamageState): void {
    d.damageState = state;
    d.dentOverlays.visible = state === 1 || state === 2;
    d.crackOverlays.visible = state === 2;
    // State 3 removes the central panel physically from both rendering & ballistic raycasts!
    d.centerBreachPanel.visible = state < 3;
    d.breachSplinterRim.visible = state === 3;
  }

  private repairDoor(d: DestructibleDoorRuntime, fromRemote = false): void {
    // Re-parent any detached groups cleanly back into hinge hierarchy
    if (d.slabContainer.parent !== d.hingePivot) {
      d.hingePivot.add(d.slabContainer);
    }
    if (d.lowerHalfGroup.parent !== d.slabContainer) {
      d.slabContainer.add(d.lowerHalfGroup);
    }
    if (d.upperHalfGroup.parent !== d.slabContainer) {
      d.slabContainer.add(d.upperHalfGroup);
    }

    d.slabContainer.position.set(0, 0, 0);
    d.slabContainer.rotation.set(0, 0, 0);
    d.lowerHalfGroup.position.set(0, 0, 0);
    d.lowerHalfGroup.rotation.set(0, 0, 0);
    d.upperHalfGroup.position.set(0, 0, 0);
    d.upperHalfGroup.rotation.set(0, 0, 0);

    d.shearedBody.active = false;
    d.shearedBody.layFlatPitchSign = 1;
    d.upperSplitBody.active = false;
    d.upperSplitBody.layFlatPitchSign = 1;
    d.lowerSplitBody.active = false;
    d.lowerSplitBody.layFlatPitchSign = 1;
    d.splitEdgeLower.visible = false;
    d.splitEdgeUpper.visible = false;

    d.hingeMode = 'attached';
    d.destructionOutcome = 'none';
    d.angleRad = 0;
    d.angularVel = 0;
    d.latched = true;
    d.softClosing = false;
    d.chipDamage = 0;
    d.splitCollapseTimerSec = 0;
    d.jambShudderTimer = 0;
    d.kickCooldownTimer = 0;
    d.hingePivot.rotation.set(0, 0, 0);
    this.penSystem.repairSurface(`door_${d.id}_upper`);
    this.penSystem.repairSurface(`door_${d.id}_lower`);
    this.setDamageStateVisuals(d, 0);

    d.dynamicSlab.active = true;
    d.dynamicSlab.rigidBlocked = true;
    d.interactProxy.visible = true;
    d.frameRepairProxy.visible = false;
    this.syncDynamicSlabTransform(d);

    const centerPos = this._tmpV3;
    this.getDoorCenterWorldPos(d.id, centerPos);
    this.synth.play('repair', centerPos.distanceTo(this.listenerPos));
    if (!fromRemote) {
      this.emitBroadcast(d, 'repair');
    }
  }

  /** Step all doors, hinge physics, split-collapse timers, detached debris, and splinter pool */
  public update(dt: number, listenerPos?: Readonly<THREE.Vector3>): void {
    const clampedDt = Math.min(Math.max(dt, 0.0001), 0.05);
    if (listenerPos) this.listenerPos.copy(listenerPos);
    this.penSystem.update(clampedDt, this.listenerPos);

    for (let i = 0; i < this.doorList.length; i++) {
      const d = this.doorList[i];
      if (d.nudgeBroadcastCooldown > 0) {
        d.nudgeBroadcastCooldown = Math.max(0, d.nudgeBroadcastCooldown - clampedDt);
      }
      if (d.kickCooldownTimer > 0) {
        d.kickCooldownTimer = Math.max(0, d.kickCooldownTimer - clampedDt);
      }

      if (d.hingeMode === 'attached' || d.hingeMode === 'splitting') {
        if (!d.latched) {
          d.angleRad += d.angularVel * clampedDt;
          // Viscous hinge friction + soft-close extra control
          const damp = d.softClosing ? 1.85 : 3.2;
          d.angularVel *= Math.exp(-damp * clampedDt);
          if (Math.abs(d.angularVel) < 0.025) {
            d.angularVel = 0;
          }

          const minA = d.spec.swingSign > 0 ? 0 : -d.spec.maxOpenRad;
          const maxA = d.spec.swingSign > 0 ? d.spec.maxOpenRad : 0;

          // Hard doorstop bounce at max open angle
          if (d.spec.swingSign > 0 && d.angleRad >= maxA) {
            d.angleRad = maxA;
            if (d.angularVel > 3.5) {
              this.getDoorCenterWorldPos(d.id, this._tmpV3);
              this.synth.play('slam', this._tmpV3.distanceTo(this.listenerPos));
            }
            d.angularVel = -d.angularVel * 0.22;
          } else if (d.spec.swingSign < 0 && d.angleRad <= minA) {
            d.angleRad = minA;
            if (d.angularVel < -3.5) {
              this.getDoorCenterWorldPos(d.id, this._tmpV3);
              this.synth.play('slam', this._tmpV3.distanceTo(this.listenerPos));
            }
            d.angularVel = -d.angularVel * 0.22;
          }

          // Re-latch when swinging back into closed jamb (< ~3.15°)
          const movingTowardClosed = d.angularVel * d.spec.swingSign < -0.04;
          const crossedZero =
            (d.spec.swingSign > 0 && d.angleRad <= 0) ||
            (d.spec.swingSign < 0 && d.angleRad >= 0);

          if (
            d.hingeMode === 'attached' &&
            (crossedZero || (movingTowardClosed && Math.abs(d.angleRad) < LATCH_ANGLE_RAD))
          ) {
            const impactSpeed = Math.abs(d.angularVel);
            const wasSoft = d.softClosing || impactSpeed < 2.35;
            d.angleRad = 0;
            d.angularVel = 0;
            d.latched = true;
            d.softClosing = false;
            d.dynamicSlab.rigidBlocked = true;

            this.getDoorCenterWorldPos(d.id, this._tmpV3);
            const distM = this._tmpV3.distanceTo(this.listenerPos);
            if (wasSoft) {
              this.synth.play('latch_soft', distM);
              this.emitAcoustic(d, this._tmpV3, 2.2, 0.12, 'latch_soft');
            } else {
              this.synth.play('slam', distM);
              this.emitAcoustic(d, this._tmpV3, 18.0, 0.82, 'slam');
            }
          }
        }

        d.hingePivot.rotation.y = d.angleRad;
        if (d.hingeMode === 'attached') {
          if (d.jambShudderTimer > 0) {
            d.jambShudderTimer = Math.max(0, d.jambShudderTimer - clampedDt);
            const tNorm = d.jambShudderTimer / 0.18;
            d.slabContainer.position.z =
              Math.sin(tNorm * Math.PI * 5.0) * 0.016 * tNorm;
          } else if (d.slabContainer.position.z !== 0) {
            d.slabContainer.position.z = 0;
          }
          this.syncDynamicSlabTransform(d);
        }

        // Outcome B: Shuddering & delayed hinge collapse (0.55s–0.95s)
        if (d.hingeMode === 'splitting') {
          d.splitCollapseTimerSec -= clampedDt;
          const sagT = THREE.MathUtils.clamp(1 - d.splitCollapseTimerSec / 0.75, 0, 1);
          d.upperHalfGroup.rotation.z = -0.14 - sagT * 0.22;
          d.lowerHalfGroup.rotation.z = 0.06 + sagT * 0.14;
          if (d.splitCollapseTimerSec <= 0) {
            this.collapseSplitHalves(d);
          }
        }
      }

      // Step detached floor-settling rigid debris bodies
      if (d.shearedBody.active && !d.shearedBody.settled) {
        this.stepDebrisBody(d.shearedBody, clampedDt, true);
      }
      if (d.upperSplitBody.active && !d.upperSplitBody.settled) {
        this.stepDebrisBody(d.upperSplitBody, clampedDt, false);
      }
      if (d.lowerSplitBody.active && !d.lowerSplitBody.settled) {
        this.stepDebrisBody(d.lowerSplitBody, clampedDt, false);
      }
    }

    // Step splinter & hinge-spark particle pool
    for (let i = 0; i < this.splinters.length; i++) {
      const p = this.splinters[i];
      if (!p.active) continue;
      p.age += clampedDt;
      if (p.age >= p.maxAge) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }
      p.vel.y -= 13.5 * clampedDt;
      p.mesh.position.addScaledVector(p.vel, clampedDt);
      p.mesh.rotation.x += p.angVel.x * clampedDt;
      p.mesh.rotation.y += p.angVel.y * clampedDt;
      p.mesh.rotation.z += p.angVel.z * clampedDt;
      if (p.mesh.position.y < p.floorY) {
        p.mesh.position.y = p.floorY;
        p.vel.y = Math.abs(p.vel.y) * 0.26;
        p.vel.x *= 0.62;
        p.vel.z *= 0.62;
        p.angVel.multiplyScalar(0.55);
      }
    }
  }

  private stepDebrisBody(body: DebrisBodyState, dt: number, layFlatTarget: boolean): void {
    body.vel.y -= 15.5 * dt;
    body.pos.addScaledVector(body.vel, dt);
    body.group.position.copy(body.pos);

    // Apply rotational tumble
    this._tmpEuler.setFromQuaternion(body.group.quaternion, 'YXZ');
    this._tmpEuler.x += body.angVel.x * dt;
    this._tmpEuler.y += body.angVel.y * dt;
    this._tmpEuler.z += body.angVel.z * dt;

    // Ground plane contact & flat settling
    const groundY = body.floorY + body.halfThickness + 0.02;
    if (body.pos.y <= groundY) {
      body.pos.y = groundY;
      body.group.position.y = groundY;
      if (!body.bounced) {
        body.bounced = true;
        this.synth.play('slab_crash', body.pos.distanceTo(this.listenerPos));
      }
      if (Math.abs(body.vel.y) > 0.7) {
        body.vel.y = Math.abs(body.vel.y) * 0.2;
      } else {
        body.vel.y = 0;
      }
      body.vel.x *= Math.exp(-7.5 * dt);
      body.vel.z *= Math.exp(-7.5 * dt);
      body.angVel.multiplyScalar(Math.exp(-8.0 * dt));

      // Gently lay the slab flat onto the floor in its forward travel direction
      const targetPitch = body.layFlatPitchSign * (layFlatTarget ? Math.PI * 0.5 : Math.PI * 0.48);
      this._tmpEuler.x = THREE.MathUtils.damp(this._tmpEuler.x, targetPitch, 7.5, dt);
      this._tmpEuler.z = THREE.MathUtils.damp(this._tmpEuler.z, 0, 7.5, dt);

      if (
        body.vel.lengthSq() < 0.008 &&
        body.angVel.lengthSq() < 0.02 &&
        Math.abs(this._tmpEuler.x - targetPitch) < 0.03
      ) {
        this._tmpEuler.x = targetPitch;
        this._tmpEuler.z = 0;
        body.settled = true;
      }
    }

    body.group.quaternion.setFromEuler(this._tmpEuler);
  }

  private syncDynamicSlabTransform(d: DestructibleDoorRuntime): void {
    const worldYaw = d.spec.closedYawRad + d.angleRad;
    d.dynamicSlab.dirX = Math.cos(worldYaw);
    d.dynamicSlab.dirZ = -Math.sin(worldYaw);
  }

  private emitAcoustic(
    d: DestructibleDoorRuntime,
    pos: Readonly<THREE.Vector3>,
    radiusM: number,
    loudness: number,
    kind: DoorAudioCueKind,
    actorTeam?: 'A' | 'B' | 'FFA',
  ): void {
    if (!this.onAcousticEvent) return;
    this.onAcousticEvent({
      doorId: d.id,
      position: pos.clone(),
      radiusM,
      loudness,
      kind,
      actorTeam,
    });
  }

  private emitBroadcast(
    d: DestructibleDoorRuntime,
    action: DoorActionPayload['action'],
    point?: Readonly<THREE.Vector3>,
    dir?: Readonly<THREE.Vector3>,
  ): void {
    if (!this.onActionBroadcast) return;
    this.onActionBroadcast({
      doorId: d.id,
      action,
      angleRad: Number(d.angleRad.toFixed(4)),
      angularVel: Number(d.angularVel.toFixed(3)),
      latched: d.latched,
      damageState: d.damageState,
      chipDamage: Math.round(d.chipDamage),
      hingeMode: d.hingeMode,
      destructionOutcome: d.destructionOutcome,
      seed: d.destructionSeed,
      px: point ? Number(point.x.toFixed(3)) : undefined,
      py: point ? Number(point.y.toFixed(3)) : undefined,
      pz: point ? Number(point.z.toFixed(3)) : undefined,
      dx: dir ? Number(dir.x.toFixed(3)) : undefined,
      dy: dir ? Number(dir.y.toFixed(3)) : undefined,
      dz: dir ? Number(dir.z.toFixed(3)) : undefined,
    });
  }

  /** Export full snapshots of all doors for multiplayer join / reconnect sync */
  public exportAllSnapshots(): SyncedDoorSnapshot[] {
    return this.doorList.map((d) => ({
      doorId: d.id,
      angleRad: Number(d.angleRad.toFixed(4)),
      angularVel: Number(d.angularVel.toFixed(3)),
      latched: d.latched,
      damageState: d.damageState,
      chipDamage: Math.round(d.chipDamage),
      hingeMode: d.hingeMode,
      destructionOutcome: d.destructionOutcome,
      seed: d.destructionSeed,
    }));
  }

  /** Idempotent reconciliation of remote multiplayer door action packets */
  public applyRemoteAction(payload: DoorActionPayload): void {
    const d = this.doors.get(payload.doorId);
    if (!d) return;

    const pt =
      payload.px !== undefined && payload.py !== undefined && payload.pz !== undefined
        ? this._tmpRemotePt.set(payload.px, payload.py, payload.pz)
        : this.getDoorCenterWorldPos(d.id, this._tmpRemotePt)
          ? this._tmpRemotePt
          : this._tmpRemotePt.set(
              d.spec.hingePos[0],
              d.spec.hingePos[1] + 1.1,
              d.spec.hingePos[2],
            );
    const dir =
      payload.dx !== undefined && payload.dy !== undefined && payload.dz !== undefined
        ? this._tmpRemoteDir.set(payload.dx, payload.dy, payload.dz)
        : this._tmpRemoteDir.set(0, 0, -1);

    if (payload.action === 'repair') {
      this.repairDoor(d, true);
      return;
    }

    if (payload.action === 'kick_destroy' && d.hingeMode === 'attached') {
      const outcome: DoorDestructionOutcome =
        payload.destructionOutcome === 'split_collapse' ? 'split_collapse' : 'hinge_shear';
      const againstHinge = this.getSwingAlignmentDot(d, dir.x, dir.z) < -0.05;
      this.applyDestructiveKickOutcome(d, outcome, dir, payload.seed, undefined, true, againstHinge);
      return;
    }

    if (payload.action === 'kick_breach' && d.hingeMode === 'attached') {
      this.executeKick(d.id, dir, 1.0, false, undefined, true, payload.seed);
      return;
    }

    if (payload.action === 'melee_bash' && d.hingeMode === 'attached') {
      d.jambShudderTimer = 0.16;
      const targetPenId =
        pt.y < d.spec.hingePos[1] + d.spec.height * 0.48
          ? `door_${d.id}_lower`
          : `door_${d.id}_upper`;
      this.penSystem.applyMeleeImpact(targetPenId, pt, dir, 'bash', payload.seed);
      d.damageState = Math.max(d.damageState, payload.damageState) as DoorDamageState;
      d.dentOverlays.visible = false;
      d.crackOverlays.visible = false;
      d.breachSplinterRim.visible = false;
      d.centerBreachPanel.visible = true;
      const cue: DoorAudioCueKind =
        payload.damageState === 1
          ? 'wood_dent'
          : payload.damageState === 2
            ? 'wood_crack'
            : 'wood_breach';
      this.spawnBurst(pt, dir, payload.damageState === 3 ? 16 : 9, d.spec.hingePos[1], false);
      this.synth.play(cue, pt.distanceTo(this.listenerPos));
      return;
    }

    if (payload.action === 'bullet_chip' && d.hingeMode === 'attached') {
      this.spawnBurst(pt, dir, 4, d.spec.hingePos[1], false);
      d.chipDamage = payload.chipDamage;
      if (payload.damageState > d.damageState) {
        this.setDamageStateVisuals(d, payload.damageState);
        this.synth.play(
          payload.damageState === 3 ? 'wood_breach' : 'wood_crack',
          pt.distanceTo(this.listenerPos),
        );
      }
      return;
    }

    // Reconcile hinge angle, velocity & latch for open / peek / close / close_soft / nudge
    if (d.hingeMode === 'attached') {
      d.angleRad = payload.angleRad;
      d.angularVel = payload.angularVel;
      d.latched = payload.latched;
      d.softClosing = payload.action === 'close_soft';
      d.dynamicSlab.rigidBlocked = d.latched;
      d.hingePivot.rotation.y = d.angleRad;
      this.syncDynamicSlabTransform(d);
      if (payload.action === 'open' || payload.action === 'peek' || payload.action === 'close_soft') {
        this.synth.play('knob_turn', pt.distanceTo(this.listenerPos));
      }
    }
  }

  /** Apply full snapshot on match join / reconnect (idempotent) */
  public applySnapshotList(list: readonly SyncedDoorSnapshot[]): void {
    for (let i = 0; i < list.length; i++) {
      const snap = list[i];
      const d = this.doors.get(snap.doorId);
      if (!d) continue;

      this.setDamageStateVisuals(d, snap.damageState);
      d.chipDamage = snap.chipDamage;

      if (snap.hingeMode !== 'attached' && d.hingeMode === 'attached') {
        const outcome: DoorDestructionOutcome =
          snap.destructionOutcome === 'split_collapse' ? 'split_collapse' : 'hinge_shear';
        this._tmpV1.set(0, 0, -1);
        this.applyDestructiveKickOutcome(d, outcome, this._tmpV1, snap.seed, undefined, true);
      } else if (snap.hingeMode === 'attached') {
        if (d.hingeMode !== 'attached') {
          this.repairDoor(d, true);
          this.setDamageStateVisuals(d, snap.damageState);
        }
        d.angleRad = snap.angleRad;
        d.angularVel = snap.angularVel;
        d.latched = snap.latched;
        d.dynamicSlab.rigidBlocked = d.latched;
        d.hingePivot.rotation.y = d.angleRad;
        this.syncDynamicSlabTransform(d);
      }
    }
  }

  public dispose(): void {
    this.penSystem.dispose();
    for (const g of this.trackedGeos) g.dispose();
    this.trackedGeos.length = 0;
    this.materials.woodBunker.dispose();
    this.materials.woodReinforced.dispose();
    this.materials.rawSplinterWood.dispose();
    this.materials.dentDark.dispose();
    this.materials.frameSteel.dispose();
    this.materials.brassHardware.dispose();
    this.materials.hingeIron.dispose();
    this.materials.sparkMat.dispose();
    this.materials.proxyMat.dispose();
    for (const t of this.materials.textures) t.dispose();
    this.root.parent?.remove(this.root);
    this.particleRoot.parent?.remove(this.particleRoot);
  }
}

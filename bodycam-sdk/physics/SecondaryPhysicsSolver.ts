import * as THREE from 'three';
import { OperatorId, SecondaryBoneName } from '../operator/OperatorTypes';

export const SECONDARY_FIXED_DT = 1 / 120;
export const SECONDARY_MAX_SUBSTEPS = 4;
export const SECONDARY_MAX_FRAME_DT = 0.05;
export const SECONDARY_MAX_SCALAR_SPRINGS = 48;

export const SECONDARY_CHANNEL_NAMES: readonly SecondaryBoneName[] = [
  'sec_chest_l',
  'sec_chest_r',
  'sec_glute_l',
  'sec_glute_r',
  'sec_bicep_l',
  'sec_tricep_l',
  'sec_forearm_l',
  'sec_bicep_r',
  'sec_tricep_r',
  'sec_forearm_r',
] as const;

export const SECONDARY_CHANNEL_COUNT = SECONDARY_CHANNEL_NAMES.length; // 10 channels = 30 scalar springs (<= 48)

export interface SecondaryMorphBinding {
  readonly channelIndex: number;
  readonly mesh: THREE.Mesh;
  readonly morphIndex: number;
  readonly axis: 0 | 1 | 2;
  readonly scale: number;
}

interface ChannelTuning {
  readonly enabled: boolean;
  readonly stiffness: readonly [number, number, number];
  readonly dampingRatio: number;
  readonly massKg: number;
  readonly minClamp: readonly [number, number, number];
  readonly maxClamp: readonly [number, number, number];
  readonly rotClampRad: number;
  readonly maxVelMps: number;
}

const DISABLED_CHANNEL: ChannelTuning = {
  enabled: false,
  stiffness: [0, 0, 0],
  dampingRatio: 1,
  massKg: 1,
  minClamp: [0, 0, 0],
  maxClamp: [0, 0, 0],
  rotClampRad: 0,
  maxVelMps: 0,
};

const FEMALE_CHEST: ChannelTuning = {
  enabled: true,
  stiffness: [160, 140, 180],
  dampingRatio: 0.55,
  massKg: 0.45,
  minClamp: [-0.008, -0.014, -0.006],
  maxClamp: [0.008, 0.010, 0.010],
  rotClampRad: 0.06,
  maxVelMps: 0.45,
};

const FEMALE_GLUTE: ChannelTuning = {
  enabled: true,
  stiffness: [210, 190, 220],
  dampingRatio: 0.62,
  massKg: 0.75,
  minClamp: [-0.006, -0.010, -0.008],
  maxClamp: [0.006, 0.008, 0.008],
  rotClampRad: 0.04,
  maxVelMps: 0.35,
};

const MALE_UPPER_ARM: ChannelTuning = {
  enabled: true,
  stiffness: [320, 300, 340],
  dampingRatio: 0.78,
  massKg: 0.35,
  minClamp: [-0.003, -0.004, -0.003],
  maxClamp: [0.003, 0.004, 0.003],
  rotClampRad: 0.02,
  maxVelMps: 0.22,
};

const MALE_FOREARM: ChannelTuning = {
  enabled: true,
  stiffness: [420, 400, 420],
  dampingRatio: 0.82,
  massKg: 0.22,
  minClamp: [-0.002, -0.003, -0.002],
  maxClamp: [0.002, 0.003, 0.002],
  rotClampRad: 0.015,
  maxVelMps: 0.18,
};

function getChannelTuning(operatorId: OperatorId, ch: number): ChannelTuning {
  if (operatorId === 'FEMALE') {
    if (ch === 0 || ch === 1) return FEMALE_CHEST;
    if (ch === 2 || ch === 3) return FEMALE_GLUTE;
    return DISABLED_CHANNEL;
  }
  // MALE
  if (ch === 4 || ch === 5 || ch === 7 || ch === 8) return MALE_UPPER_ARM;
  if (ch === 6 || ch === 9) return MALE_FOREARM;
  return DISABLED_CHANNEL;
}

/**
 * Fixed-step 120 Hz Structure-of-Arrays (SoA) Secondary Soft-Tissue Physics Solver.
 * - Pre-allocated flat `Float32Array` buffers (capacity 48 scalar springs, 30 active slots)
 * - Strictly zero heap allocations during `step()` and impulse injection
 * - Deterministic `FIXED_DT = 1 / 120`, `MAX_SUBSTEPS = 4`, input dt clamped `<= 0.05 s`
 * - Enforces hard linear displacement clamps, velocity clamps, and angular clamps per operator
 * - Locks unused channels per operator (`enabled === 0`, guaranteed zero offset)
 */
export class SecondaryPhysicsSolver {
  public readonly operatorId: OperatorId;

  // Flat SoA buffers (size 48 scalar springs)
  public readonly pos = new Float32Array(SECONDARY_MAX_SCALAR_SPRINGS);
  public readonly vel = new Float32Array(SECONDARY_MAX_SCALAR_SPRINGS);
  public readonly stiffness = new Float32Array(SECONDARY_MAX_SCALAR_SPRINGS);
  public readonly dampingCoeff = new Float32Array(SECONDARY_MAX_SCALAR_SPRINGS);
  public readonly invMass = new Float32Array(SECONDARY_MAX_SCALAR_SPRINGS);
  public readonly minClamp = new Float32Array(SECONDARY_MAX_SCALAR_SPRINGS);
  public readonly maxClamp = new Float32Array(SECONDARY_MAX_SCALAR_SPRINGS);
  public readonly maxVel = new Float32Array(SECONDARY_MAX_SCALAR_SPRINGS);
  public readonly extAccel = new Float32Array(SECONDARY_MAX_SCALAR_SPRINGS);
  public readonly pendingImpulse = new Float32Array(SECONDARY_MAX_SCALAR_SPRINGS);
  public readonly enabled = new Uint8Array(SECONDARY_MAX_SCALAR_SPRINGS);

  // Per-channel rotational clamp & solved rotational offsets (radians)
  public readonly rotClamp = new Float32Array(SECONDARY_CHANNEL_COUNT);
  public readonly rotX = new Float32Array(SECONDARY_CHANNEL_COUNT);
  public readonly rotY = new Float32Array(SECONDARY_CHANNEL_COUNT);
  public readonly rotZ = new Float32Array(SECONDARY_CHANNEL_COUNT);

  private accumulator = 0;
  private decayMode = false;
  private readonly morphBindings: SecondaryMorphBinding[] = [];

  constructor(operatorId: OperatorId) {
    this.operatorId = operatorId;
    this.configureOperator(operatorId);
  }

  private configureOperator(operatorId: OperatorId): void {
    this.pos.fill(0);
    this.vel.fill(0);
    this.extAccel.fill(0);
    this.pendingImpulse.fill(0);
    this.rotX.fill(0);
    this.rotY.fill(0);
    this.rotZ.fill(0);
    this.enabled.fill(0);

    for (let ch = 0; ch < SECONDARY_CHANNEL_COUNT; ch++) {
      const cfg = getChannelTuning(operatorId, ch);
      this.rotClamp[ch] = cfg.rotClampRad;
      const base = ch * 3;
      if (!cfg.enabled) {
        this.enabled[base] = 0;
        this.enabled[base + 1] = 0;
        this.enabled[base + 2] = 0;
        continue;
      }
      const invM = 1.0 / cfg.massKg;
      for (let axis = 0; axis < 3; axis++) {
        const idx = base + axis;
        const k = cfg.stiffness[axis];
        this.enabled[idx] = 1;
        this.stiffness[idx] = k;
        this.invMass[idx] = invM;
        this.dampingCoeff[idx] = 2 * cfg.dampingRatio * Math.sqrt(k * cfg.massKg);
        this.minClamp[idx] = cfg.minClamp[axis];
        this.maxClamp[idx] = cfg.maxClamp[axis];
        this.maxVel[idx] = cfg.maxVelMps;
      }
    }
  }

  public setDecayMode(decay: boolean): void {
    this.decayMode = decay;
  }

  public reset(): void {
    this.pos.fill(0);
    this.vel.fill(0);
    this.extAccel.fill(0);
    this.pendingImpulse.fill(0);
    this.rotX.fill(0);
    this.rotY.fill(0);
    this.rotZ.fill(0);
    this.accumulator = 0;
  }

  /**
   * Optional hook for future `.glb` assets with blendshapes / morph targets.
   */
  public bindMorphTarget(
    channelIndex: number,
    mesh: THREE.Mesh,
    morphIndex: number,
    axis: 0 | 1 | 2 = 1,
    scale = 65.0,
  ): void {
    if (channelIndex < 0 || channelIndex >= SECONDARY_CHANNEL_COUNT) return;
    this.morphBindings.push({ channelIndex, mesh, morphIndex, axis, scale });
  }

  /**
   * Sets continuous local-space excitation acceleration (m/s²) for a channel. Zero allocations.
   */
  public setChannelAcceleration(channelIndex: number, ax: number, ay: number, az: number): void {
    const base = channelIndex * 3;
    if (this.enabled[base] === 0) return;
    if (this.decayMode) {
      this.extAccel[base] = 0;
      this.extAccel[base + 1] = 0;
      this.extAccel[base + 2] = 0;
      return;
    }
    this.extAccel[base] = ax;
    this.extAccel[base + 1] = ay;
    this.extAccel[base + 2] = az;
  }

  /**
   * Injects an instantaneous velocity impulse (m/s) into a channel (e.g., footstep heel strike,
   * landing shock, or weapon recoil kick). Zero allocations.
   */
  public addChannelImpulse(channelIndex: number, dvx: number, dvy: number, dvz: number): void {
    const base = channelIndex * 3;
    if (this.enabled[base] === 0 || this.decayMode) return;
    this.pendingImpulse[base] += dvx;
    this.pendingImpulse[base + 1] += dvy;
    this.pendingImpulse[base + 2] += dvz;
  }

  /**
   * Broadcasts an impulse across all enabled channels (scaled by anatomical relevance).
   */
  public addGlobalImpulse(dvx: number, dvy: number, dvz: number): void {
    if (this.decayMode) return;
    for (let ch = 0; ch < SECONDARY_CHANNEL_COUNT; ch++) {
      const base = ch * 3;
      if (this.enabled[base] === 0) continue;
      this.pendingImpulse[base] += dvx;
      this.pendingImpulse[base + 1] += dvy;
      this.pendingImpulse[base + 2] += dvz;
    }
  }

  /**
   * Advances the fixed-step 120 Hz simulation by `rawDt` seconds (clamped `<= 0.05 s`, max 4 substeps).
   * Zero heap allocations. Returns the number of substeps executed.
   */
  public step(rawDt: number): number {
    const dt = rawDt > SECONDARY_MAX_FRAME_DT ? SECONDARY_MAX_FRAME_DT : rawDt < 0 ? 0 : rawDt;
    this.accumulator += dt;

    let substeps = 0;
    const h = SECONDARY_FIXED_DT;
    const totalSprings = SECONDARY_CHANNEL_COUNT * 3;
    const pos = this.pos;
    const vel = this.vel;
    const kArr = this.stiffness;
    const cArr = this.dampingCoeff;
    const invM = this.invMass;
    const minC = this.minClamp;
    const maxC = this.maxClamp;
    const maxV = this.maxVel;
    const extA = this.extAccel;
    const imp = this.pendingImpulse;
    const en = this.enabled;
    const decayMult = this.decayMode ? 2.4 : 1.0;

    // Consume pending velocity impulses once before substeps
    for (let i = 0; i < totalSprings; i++) {
      if (en[i] === 0) {
        imp[i] = 0;
        pos[i] = 0;
        vel[i] = 0;
        continue;
      }
      const dv = imp[i];
      if (dv !== 0) {
        let nv = vel[i] + dv;
        const mv = maxV[i];
        if (nv > mv) nv = mv;
        else if (nv < -mv) nv = -mv;
        vel[i] = nv;
        imp[i] = 0;
      }
    }

    while (this.accumulator >= h && substeps < SECONDARY_MAX_SUBSTEPS) {
      this.accumulator -= h;
      substeps++;

      for (let i = 0; i < totalSprings; i++) {
        if (en[i] === 0) continue;

        let x = pos[i];
        let v = vel[i];
        const aDrive = this.decayMode ? 0 : extA[i];
        // Semi-implicit Euler spring-damper integration
        const force = -kArr[i] * x - cArr[i] * decayMult * v;
        const acc = force * invM[i] + aDrive;

        v += acc * h;
        const mv = maxV[i];
        if (v > mv) v = mv;
        else if (v < -mv) v = -mv;

        x += v * h;
        const lo = minC[i];
        const hi = maxC[i];
        if (x < lo) {
          x = lo;
          if (v < 0) v = 0;
        } else if (x > hi) {
          x = hi;
          if (v > 0) v = 0;
        }

        pos[i] = x;
        vel[i] = v;
      }
    }

    // Prevent accumulator runaway if frame spiked beyond MAX_SUBSTEPS
    if (this.accumulator > h * SECONDARY_MAX_SUBSTEPS) {
      this.accumulator = h;
    }

    // Derive strictly clamped angular micro-tilt per channel
    for (let ch = 0; ch < SECONDARY_CHANNEL_COUNT; ch++) {
      const base = ch * 3;
      if (en[base] === 0) {
        this.rotX[ch] = 0;
        this.rotY[ch] = 0;
        this.rotZ[ch] = 0;
        continue;
      }
      const rc = this.rotClamp[ch];
      const dx = pos[base];
      const dy = pos[base + 1];
      const dz = pos[base + 2];

      let rx = dy * 4.0 - dz * 2.2;
      let ry = dx * 3.0;
      let rz = -dx * 3.5;

      if (rx > rc) rx = rc;
      else if (rx < -rc) rx = -rc;
      if (ry > rc) ry = rc;
      else if (ry < -rc) ry = -rc;
      if (rz > rc) rz = rc;
      else if (rz < -rc) rz = -rc;

      this.rotX[ch] = rx;
      this.rotY[ch] = ry;
      this.rotZ[ch] = rz;
    }

    // Optional morph-target update for `.glb` assets
    for (let m = 0; m < this.morphBindings.length; m++) {
      const b = this.morphBindings[m];
      const inf = b.mesh.morphTargetInfluences;
      if (!inf || b.morphIndex < 0 || b.morphIndex >= inf.length) continue;
      const val = pos[b.channelIndex * 3 + b.axis] * b.scale;
      inf[b.morphIndex] = val < 0 ? 0 : val > 1 ? 1 : val;
    }

    return substeps;
  }

  public isChannelEnabled(channelIndex: number): boolean {
    if (channelIndex < 0 || channelIndex >= SECONDARY_CHANNEL_COUNT) return false;
    return this.enabled[channelIndex * 3] === 1;
  }
}

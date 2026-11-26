import * as THREE from 'three';
import { FACIAL_MORPH_COUNT, FACIAL_MORPH_INDEX } from './AnatomicalHeadBuilder';

export type FacialExpressionMode = 'human' | 'zombie';

export type FacialExpressionIntent =
  | 'calm'
  | 'alert'
  | 'aiming'
  | 'suppressed'
  | 'injured'
  | 'shamble'
  | 'aggro'
  | 'lunge'
  | 'stagger'
  | 'dead';

export interface FacialExpressionInput {
  mode: FacialExpressionMode;
  intent: FacialExpressionIntent;
  /** 0..1 continuous combat stress / arousal */
  stress01: number;
  /** 0..1 physical trauma / low-health grimace */
  injury01: number;
  /** 0..1 sharp flinch impulse (damage hit / near detonation) */
  flinchImpulse01: number;
  /** 0..1 tactical Free Zoom / focus squint intensity */
  focus01?: number;
  /** World-space point eyes should track (converted into head local space, -Z forward) */
  gazeTargetWorld?: Readonly<THREE.Vector3> | null;
  /** Optional explicit local gaze yaw override (radians) when gazeTargetWorld is omitted */
  localGazeYaw?: number;
  /** Optional explicit local gaze pitch override (radians) when gazeTargetWorld is omitted */
  localGazePitch?: number;
  /** Distance from local camera in meters (for LOD throttling & freeze > 35m) */
  distanceToCameraM: number;
  /** False skips evaluation cleanly (LOD freeze) */
  isVisible: boolean;
}

const LOD_FULL_DIST_M = 25;
const LOD_THROTTLE_DIST_M = 35;
const LOD_THROTTLE_INTERVAL_S = 0.09; // ~11 Hz between 25m and 35m

const MAX_EYE_YAW_RAD = 0.48; // ~27.5 deg
const MAX_EYE_PITCH_RAD = 0.30; // ~17.2 deg

/**
 * Zero-GC per-actor facial animation & gaze controller driving the shared 15 morph targets
 * plus independent left/right eyeball pivots (`eye_l`, `eye_r`).
 *
 * Enforces distance LOD tiers (`<= 25m` 60 Hz, `25..35m` ~11 Hz, `> 35m` or invisible frozen)
 * and holds zero heap allocations inside `step()`.
 */
export class FacialExpressionController {
  private readonly currentWeights = new Float32Array(FACIAL_MORPH_COUNT);
  private readonly targetWeights = new Float32Array(FACIAL_MORPH_COUNT);

  private blinkTimerSec: number;
  private blinkElapsedSec = -1;
  private saccadeTimerSec: number;
  private saccadeYawOffset = 0;
  private saccadePitchOffset = 0;

  private curEyeYaw = 0;
  private curEyePitch = 0;
  private lodAccumSec = 0;

  // Scratch math objects (zero allocations in hot loop)
  private readonly _invHeadMat = new THREE.Matrix4();
  private readonly _localGaze = new THREE.Vector3();
  private readonly _eyeMidLocal = new THREE.Vector3(0, 0.1035, -0.0705);

  constructor(seed = 1) {
    const normSeed = Math.abs(Math.sin(seed * 12.9898) * 43758.5453) % 1;
    this.blinkTimerSec = 1.4 + normSeed * 3.6;
    this.saccadeTimerSec = 0.5 + normSeed * 1.4;
  }

  public getCurrentWeight(name: keyof typeof FACIAL_MORPH_INDEX): number {
    return this.currentWeights[FACIAL_MORPH_INDEX[name]];
  }

  public step(
    dtRaw: number,
    input: Readonly<FacialExpressionInput>,
    headObjectForGaze: THREE.Object3D | null,
    morphInfluences: number[] | null | undefined,
    eyeL: THREE.Object3D | null | undefined,
    eyeR: THREE.Object3D | null | undefined,
    jawPivot?: THREE.Object3D | null,
  ): void {
    if (!input.isVisible || !Number.isFinite(input.distanceToCameraM)) return;
    if (input.distanceToCameraM > LOD_THROTTLE_DIST_M) return;

    const dtClamped = Math.max(0.001, Math.min(0.1, Number.isFinite(dtRaw) ? dtRaw : 0.016));
    let evalDt = dtClamped;

    if (input.distanceToCameraM > LOD_FULL_DIST_M) {
      this.lodAccumSec += dtClamped;
      if (this.lodAccumSec < LOD_THROTTLE_INTERVAL_S) {
        return;
      }
      evalDt = Math.min(0.25, this.lodAccumSec);
      this.lodAccumSec = 0;
    } else {
      this.lodAccumSec = 0;
    }

    const stress = THREE.MathUtils.clamp(input.stress01, 0, 1);
    const injury = THREE.MathUtils.clamp(input.injury01, 0, 1);
    const flinch = THREE.MathUtils.clamp(input.flinchImpulse01, 0, 1);
    const focus = THREE.MathUtils.clamp(input.focus01 ?? 0, 0, 1);

    // 1. Solve smooth gaze yaw/pitch (character faces local -Z)
    let targetYaw = input.localGazeYaw ?? 0;
    let targetPitch = input.localGazePitch ?? 0;

    if (input.gazeTargetWorld && headObjectForGaze) {
      headObjectForGaze.updateWorldMatrix(true, false);
      this._invHeadMat.copy(headObjectForGaze.matrixWorld).invert();
      this._localGaze.copy(input.gazeTargetWorld).applyMatrix4(this._invHeadMat);
      this._localGaze.sub(this._eyeMidLocal);
      const fwd = -this._localGaze.z;
      if (fwd > 0.08) {
        targetYaw = Math.atan2(-this._localGaze.x, fwd);
        const horiz = Math.hypot(this._localGaze.x, fwd);
        targetPitch = Math.atan2(this._localGaze.y, Math.max(0.05, horiz));
      } else {
        targetYaw = THREE.MathUtils.clamp(Math.atan2(-this._localGaze.x, Math.max(0.08, fwd)), -MAX_EYE_YAW_RAD, MAX_EYE_YAW_RAD);
        targetPitch = 0;
      }
    }

    // Subtle biological micro-saccades (minimized while aiming, focusing, or dead)
    this.saccadeTimerSec -= evalDt;
    if (this.saccadeTimerSec <= 0) {
      this.saccadeTimerSec =
        input.intent === 'aiming' || focus > 0.35
          ? 2.4
          : input.mode === 'zombie'
            ? 0.35 + Math.random() * 0.7
            : 0.9 + Math.random() * 1.8;
      const focusDamp = 1 - focus * 0.65;
      const ampYaw = (input.intent === 'aiming' || input.intent === 'dead' ? 0.008 : 0.052) * focusDamp;
      const ampPitch = (input.intent === 'aiming' || input.intent === 'dead' ? 0.005 : 0.026) * focusDamp;
      this.saccadeYawOffset = (Math.random() - 0.5) * 2 * ampYaw;
      this.saccadePitchOffset = (Math.random() - 0.5) * 2 * ampPitch;
    }

    if (input.intent === 'dead') {
      targetYaw = 0.04;
      targetPitch = -0.06;
    } else {
      targetYaw = THREE.MathUtils.clamp(targetYaw + this.saccadeYawOffset, -MAX_EYE_YAW_RAD, MAX_EYE_YAW_RAD);
      targetPitch = THREE.MathUtils.clamp(targetPitch + this.saccadePitchOffset, -MAX_EYE_PITCH_RAD, MAX_EYE_PITCH_RAD);
    }

    const eyeFollowSpeed = input.intent === 'aiming' ? 22 : 16;
    this.curEyeYaw = THREE.MathUtils.damp(this.curEyeYaw, targetYaw, eyeFollowSpeed, evalDt);
    this.curEyePitch = THREE.MathUtils.damp(this.curEyePitch, targetPitch, eyeFollowSpeed, evalDt);

    // Apply rotations to left & right eyeballs (-Z faces forward; +Y yaw turns left, +X pitch tilts up)
    if (eyeL) {
      eyeL.rotation.set(this.curEyePitch, this.curEyeYaw, 0);
    }
    if (eyeR) {
      eyeR.rotation.set(this.curEyePitch, this.curEyeYaw, 0);
    }

    // 2. Natural blinking state machine
    let blinkWeight = 0;
    if (input.intent !== 'dead') {
      if (this.blinkElapsedSec >= 0) {
        this.blinkElapsedSec += evalDt;
        const dur = input.mode === 'zombie' ? 0.12 : 0.14;
        const t = this.blinkElapsedSec / dur;
        if (t >= 1) {
          this.blinkElapsedSec = -1;
          const baseCadence =
            input.mode === 'zombie'
              ? 4.6 + Math.random() * 5.2
              : input.intent === 'suppressed'
                ? 2.1 + Math.random() * 2.0
                : focus > 0.25
                  ? 4.2 + Math.random() * 2.8
                  : 3.1 + Math.random() * 2.6;
          this.blinkTimerSec = baseCadence;
        } else {
          blinkWeight = Math.sin(t * Math.PI);
        }
      } else {
        this.blinkTimerSec -= evalDt * (focus > 0.25 ? 0.72 : 1.0);
        if (this.blinkTimerSec <= 0) {
          this.blinkElapsedSec = 0;
        }
      }
    }

    // 3. Populate target morph weights
    this.targetWeights.fill(0);
    const tgt = this.targetWeights;

    if (input.mode === 'human') {
      switch (input.intent) {
        case 'calm':
          tgt[FACIAL_MORPH_INDEX.brow_furrow_down] = 0.08 + stress * 0.16;
          tgt[FACIAL_MORPH_INDEX.eye_squint_l] = 0.06;
          tgt[FACIAL_MORPH_INDEX.eye_squint_r] = 0.06;
          tgt[FACIAL_MORPH_INDEX.mouth_tense_grimace] = 0.08;
          break;

        case 'alert':
          tgt[FACIAL_MORPH_INDEX.brow_furrow_down] = 0.22 + stress * 0.14;
          tgt[FACIAL_MORPH_INDEX.brow_inner_up] = 0.08;
          tgt[FACIAL_MORPH_INDEX.eye_squint_l] = 0.14;
          tgt[FACIAL_MORPH_INDEX.eye_squint_r] = 0.14;
          tgt[FACIAL_MORPH_INDEX.mouth_tense_grimace] = 0.18 + stress * 0.12;
          break;

        case 'aiming':
          tgt[FACIAL_MORPH_INDEX.brow_furrow_down] = 0.30;
          tgt[FACIAL_MORPH_INDEX.eye_squint_l] = 0.32;
          tgt[FACIAL_MORPH_INDEX.eye_squint_r] = 0.12;
          tgt[FACIAL_MORPH_INDEX.cheek_raise] = 0.18;
          tgt[FACIAL_MORPH_INDEX.mouth_tense_grimace] = 0.28;
          tgt[FACIAL_MORPH_INDEX.jaw_open] = 0.03;
          break;

        case 'suppressed':
          tgt[FACIAL_MORPH_INDEX.brow_furrow_down] = 0.34 + stress * 0.10;
          tgt[FACIAL_MORPH_INDEX.eye_squint_l] = 0.24;
          tgt[FACIAL_MORPH_INDEX.eye_squint_r] = 0.24;
          tgt[FACIAL_MORPH_INDEX.cheek_raise] = 0.24;
          tgt[FACIAL_MORPH_INDEX.mouth_tense_grimace] = 0.34;
          tgt[FACIAL_MORPH_INDEX.lip_corner_snarl] = 0.16;
          tgt[FACIAL_MORPH_INDEX.jaw_open] = 0.10 + stress * 0.08;
          break;

        case 'injured':
          tgt[FACIAL_MORPH_INDEX.brow_inner_up] = 0.28 + injury * 0.14;
          tgt[FACIAL_MORPH_INDEX.brow_furrow_down] = 0.26;
          tgt[FACIAL_MORPH_INDEX.eye_squint_l] = 0.34;
          tgt[FACIAL_MORPH_INDEX.eye_squint_r] = 0.34;
          tgt[FACIAL_MORPH_INDEX.cheek_raise] = 0.28;
          tgt[FACIAL_MORPH_INDEX.sneer_snarl_l] = 0.18;
          tgt[FACIAL_MORPH_INDEX.lip_corner_snarl] = 0.26;
          tgt[FACIAL_MORPH_INDEX.jaw_open] = 0.18 + injury * 0.14;
          break;

        case 'dead':
          tgt[FACIAL_MORPH_INDEX.eye_blink_l] = 0.85;
          tgt[FACIAL_MORPH_INDEX.eye_blink_r] = 0.85;
          tgt[FACIAL_MORPH_INDEX.jaw_open] = 0.16;
          break;

        default:
          break;
      }

      // Continuous focus squint, injury & flinch overlays (clamped for realistic human subtlety except flinch/blink)
      if (input.intent !== 'dead') {
        if (focus > 0.001) {
          tgt[FACIAL_MORPH_INDEX.eye_squint_l] = Math.min(0.72, tgt[FACIAL_MORPH_INDEX.eye_squint_l] + focus * 0.34);
          tgt[FACIAL_MORPH_INDEX.eye_squint_r] = Math.min(0.72, tgt[FACIAL_MORPH_INDEX.eye_squint_r] + focus * 0.34);
          tgt[FACIAL_MORPH_INDEX.brow_furrow_down] = Math.min(0.58, tgt[FACIAL_MORPH_INDEX.brow_furrow_down] + focus * 0.18);
          tgt[FACIAL_MORPH_INDEX.cheek_raise] = Math.min(0.45, tgt[FACIAL_MORPH_INDEX.cheek_raise] + focus * 0.12);
        }
        tgt[FACIAL_MORPH_INDEX.brow_inner_up] = Math.min(0.45, tgt[FACIAL_MORPH_INDEX.brow_inner_up] + injury * 0.18);
        tgt[FACIAL_MORPH_INDEX.mouth_tense_grimace] = Math.min(0.45, tgt[FACIAL_MORPH_INDEX.mouth_tense_grimace] + injury * 0.14 + stress * 0.10);
        tgt[FACIAL_MORPH_INDEX.jaw_open] = Math.min(0.42, tgt[FACIAL_MORPH_INDEX.jaw_open] + flinch * 0.22);

        const blinkCombined = Math.max(blinkWeight, flinch * 0.92);
        tgt[FACIAL_MORPH_INDEX.eye_blink_l] = Math.max(tgt[FACIAL_MORPH_INDEX.eye_blink_l], blinkCombined);
        tgt[FACIAL_MORPH_INDEX.eye_blink_r] = Math.max(tgt[FACIAL_MORPH_INDEX.eye_blink_r], blinkCombined);
      }
    } else {
      // Zombie expressions (dramatic, ragged, predatory)
      switch (input.intent) {
        case 'shamble':
          tgt[FACIAL_MORPH_INDEX.brow_furrow_down] = 0.65;
          tgt[FACIAL_MORPH_INDEX.eye_wide] = 0.35;
          tgt[FACIAL_MORPH_INDEX.jaw_open] = 0.42 + stress * 0.18;
          tgt[FACIAL_MORPH_INDEX.lip_pull_upper] = 0.56;
          tgt[FACIAL_MORPH_INDEX.sneer_snarl_l] = 0.48;
          tgt[FACIAL_MORPH_INDEX.sneer_snarl_r] = 0.32;
          break;

        case 'aggro':
          tgt[FACIAL_MORPH_INDEX.brow_furrow_down] = 0.85;
          tgt[FACIAL_MORPH_INDEX.eye_wide] = 0.68;
          tgt[FACIAL_MORPH_INDEX.cheek_raise] = 0.55;
          tgt[FACIAL_MORPH_INDEX.jaw_open] = 0.72;
          tgt[FACIAL_MORPH_INDEX.lip_pull_upper] = 0.84;
          tgt[FACIAL_MORPH_INDEX.sneer_snarl_l] = 0.75;
          tgt[FACIAL_MORPH_INDEX.sneer_snarl_r] = 0.72;
          tgt[FACIAL_MORPH_INDEX.lip_corner_snarl] = 0.68;
          break;

        case 'lunge':
          tgt[FACIAL_MORPH_INDEX.brow_furrow_down] = 0.96;
          tgt[FACIAL_MORPH_INDEX.eye_wide] = 0.85;
          tgt[FACIAL_MORPH_INDEX.cheek_raise] = 0.72;
          tgt[FACIAL_MORPH_INDEX.jaw_open] = 1.0;
          tgt[FACIAL_MORPH_INDEX.lip_pull_upper] = 0.96;
          tgt[FACIAL_MORPH_INDEX.sneer_snarl_l] = 0.92;
          tgt[FACIAL_MORPH_INDEX.sneer_snarl_r] = 0.92;
          tgt[FACIAL_MORPH_INDEX.lip_corner_snarl] = 0.88;
          break;

        case 'stagger':
          tgt[FACIAL_MORPH_INDEX.brow_inner_up] = 0.58;
          tgt[FACIAL_MORPH_INDEX.eye_squint_l] = 0.65;
          tgt[FACIAL_MORPH_INDEX.eye_squint_r] = 0.72;
          tgt[FACIAL_MORPH_INDEX.jaw_open] = 0.68;
          tgt[FACIAL_MORPH_INDEX.lip_corner_snarl] = 0.65;
          break;

        case 'dead':
          tgt[FACIAL_MORPH_INDEX.eye_blink_l] = 0.72;
          tgt[FACIAL_MORPH_INDEX.eye_blink_r] = 0.88;
          tgt[FACIAL_MORPH_INDEX.jaw_open] = 0.45;
          break;

        default:
          tgt[FACIAL_MORPH_INDEX.jaw_open] = 0.48;
          tgt[FACIAL_MORPH_INDEX.lip_pull_upper] = 0.52;
          break;
      }

      if (input.intent !== 'dead') {
        const zBlink = Math.max(blinkWeight * 0.75, flinch * 0.88);
        tgt[FACIAL_MORPH_INDEX.eye_blink_l] = Math.max(tgt[FACIAL_MORPH_INDEX.eye_blink_l], zBlink);
        tgt[FACIAL_MORPH_INDEX.eye_blink_r] = Math.max(tgt[FACIAL_MORPH_INDEX.eye_blink_r], zBlink * 0.85);
      }
    }

    // 4. Eyelid pitch follow-through (upper lid dips slightly when looking down, lifts slightly looking up)
    if (input.intent !== 'dead') {
      if (this.curEyePitch < -0.05) {
        const downRatio = Math.min(1, (-this.curEyePitch - 0.05) / 0.25);
        tgt[FACIAL_MORPH_INDEX.eye_squint_l] = Math.min(0.65, tgt[FACIAL_MORPH_INDEX.eye_squint_l] + downRatio * 0.14);
        tgt[FACIAL_MORPH_INDEX.eye_squint_r] = Math.min(0.65, tgt[FACIAL_MORPH_INDEX.eye_squint_r] + downRatio * 0.14);
      } else if (this.curEyePitch > 0.08) {
        const upRatio = Math.min(1, (this.curEyePitch - 0.08) / 0.22);
        tgt[FACIAL_MORPH_INDEX.eye_wide] = Math.min(0.85, tgt[FACIAL_MORPH_INDEX.eye_wide] + upRatio * 0.16);
      }
    }

    // 5. Exponentially damp morph weights and write to Three.js mesh influences
    const dampSpeed = blinkWeight > 0.1 || flinch > 0.15 ? 34 : 13;
    for (let i = 0; i < FACIAL_MORPH_COUNT; i++) {
      const next = THREE.MathUtils.damp(this.currentWeights[i], tgt[i], dampSpeed, evalDt);
      const clean = Number.isFinite(next) ? Math.max(0, Math.min(1.05, next)) : 0;
      this.currentWeights[i] = clean;
      if (morphInfluences && i < morphInfluences.length) {
        morphInfluences[i] = clean;
      }
    }

    // Sync optional physical jawPivot rotation cleanly with jaw_open morph weight
    if (jawPivot) {
      const jawWeight = this.currentWeights[FACIAL_MORPH_INDEX.jaw_open];
      jawPivot.rotation.x = THREE.MathUtils.damp(jawPivot.rotation.x, jawWeight * 0.40, 14, evalDt);
    }
  }
}

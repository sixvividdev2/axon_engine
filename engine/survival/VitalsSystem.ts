import * as THREE from 'three';
import { ITEMS } from '../../data/items';
import { VitalsSaveState, VitalsSnapshotState } from '../types';

export const HOLD_BREATH_MAX_SEC = 7.0;
export const HOLD_BREATH_COOLDOWN_SEC = 3.0;
export const HOLD_BREATH_REBOUND_DURATION_SEC = 2.4;

export interface VitalsUpdateResult {
  /** Combined sway multiplier (>1.0 during rebound or low vitals; 0% hold-breath suppression handled in BodycamController) */
  swayAmpMult: number;
  /** Multiplier on stamina drain (encumbrance + low hydration/hunger) */
  staminaDrainMult: number;
  /** Multiplier on stamina recovery rate */
  staminaRegenMult: number;
  /** Additional cap factor on stamina (0.35..1.0) */
  staminaCapMult: number;
  /** Multiplier on exertion accumulation */
  exertionRateMult: number;
  /** Movement speed multiplier from extreme dehydration/starvation */
  moveSpeedMult: number;
  /** Extra ragged breath severity for AudioEngine biometrics */
  fatigueBreathSeverity: number;
  /** Whether player is allowed to sprint based on vitals */
  canSprintVitals: boolean;
  /** One-shot exertion impulse to inject into BodycamController when Hold-Breath ends */
  exertionReboundImpulse: number;
  /** Subtle peripheral optical edge darkening (0..1) driven by hold-breath, low O2, and cooldown recovery */
  breathVignette: number;
  /** Diegetic audio cues triggered this frame */
  triggerInhale: boolean;
  triggerLowBreathPulse: boolean;
  lowBreathPulseIntensity: number;
  triggerExhaleGasp: boolean;
  exhaleGaspDepleted: boolean;
  triggerStomachGrowl: boolean;
  triggerFatigueSigh: boolean;
}

export interface FlashlightRenderState {
  intensity: number;
  flickering: boolean;
  diedThisFrame: boolean;
}

export class VitalsSystem {
  public hunger = 92; // 0..100
  public hydration = 90; // 0..100

  public holdBreathActive = false;
  public holdBreathRemainingSec = HOLD_BREATH_MAX_SEC;
  public holdBreathReboundSec = 0;

  public heartRateBpm = 84;
  public heartStress = 0; // 0..1 normalized cardiovascular stress

  private holdBreathHeldDurationSec = 0;
  private holdBreathLockoutSec = 0;
  private lowBreathPulseTimerSec = 0;
  private breathVignette = 0;
  private breathVignettePhase = 0;
  private stomachCueTimerSec = 14;
  private fatigueCueTimerSec = 18;
  private flickerPhase = 0;
  private lastBatteryFlickering = false;
  private adrenalineStress = 0; // 0..1 acute combat/shock spike
  private rsaPhase = 0; // respiratory sinus arrhythmia phase
  private stillDurationSec = 0; // tracks stillness before settling from ~85 -> ~70 BPM

  public reset(): void {
    this.hunger = 92;
    this.hydration = 90;
    this.holdBreathActive = false;
    this.holdBreathRemainingSec = HOLD_BREATH_MAX_SEC;
    this.holdBreathReboundSec = 0;
    this.heartRateBpm = 84;
    this.heartStress = 0;
    this.holdBreathHeldDurationSec = 0;
    this.holdBreathLockoutSec = 0;
    this.lowBreathPulseTimerSec = 0;
    this.breathVignette = 0;
    this.breathVignettePhase = 0;
    this.stomachCueTimerSec = 14;
    this.fatigueCueTimerSec = 18;
    this.flickerPhase = 0;
    this.lastBatteryFlickering = false;
    this.adrenalineStress = 0;
    this.rsaPhase = 0;
    this.stillDurationSec = 0;
  }

  public addAdrenalineImpulse(amount: number): void {
    if (amount <= 0) return;
    this.adrenalineStress = THREE.MathUtils.clamp(this.adrenalineStress + amount * 0.62, 0, 1);
    this.stillDurationSec = 0;
  }

  public setFlatline(): void {
    this.heartRateBpm = 0;
    this.heartStress = 1;
    this.adrenalineStress = 0;
  }

  public update(
    dt: number,
    opts: {
      isSprinting: boolean;
      isMoving: boolean;
      isAds: boolean;
      wantsHoldBreath: boolean;
      isHealingOrBleeding: boolean;
      encumbranceRatio: number;
      stamina: number;
      moveSpeedRatio?: number;
      crouched?: boolean;
      exertion?: number;
      health?: number;
      lightBleeding?: boolean;
      heavyBleeding?: boolean;
      heartbeatSeverity?: number;
      threatLevel?: number;
    },
  ): VitalsUpdateResult {
    const delta = Math.min(Math.max(dt, 0), 0.1);
    const enc = Math.max(0, opts.encumbranceRatio);

    // 1. Realistic Hunger & Hydration decay (accelerated by sprinting, heavy carry weight, bleeding/healing)
    const hungerRate =
      0.085 +
      (opts.isSprinting ? 0.14 : opts.isMoving ? 0.028 : 0) +
      enc * 0.065 +
      (opts.isHealingOrBleeding ? 0.075 : 0);

    const hydrationRate =
      0.11 +
      (opts.isSprinting ? 0.21 : opts.isMoving ? 0.036 : 0) +
      enc * 0.085 +
      (opts.isHealingOrBleeding ? 0.11 : 0);

    this.hunger = Math.max(0, this.hunger - hungerRate * delta);
    this.hydration = Math.max(0, this.hydration - hydrationRate * delta);

    // 2. Hold-Breath across all aim stances (Primary ADS, Canted, Point Aim — up to 7.0s, 3.0s depletion cooldown)
    if (this.holdBreathLockoutSec > 0) {
      this.holdBreathLockoutSec = Math.max(0, this.holdBreathLockoutSec - delta);
    }
    if (this.holdBreathReboundSec > 0) {
      this.holdBreathReboundSec = Math.max(0, this.holdBreathReboundSec - delta);
    }

    let triggerInhale = false;
    let triggerLowBreathPulse = false;
    let lowBreathPulseIntensity = 0;
    let triggerExhaleGasp = false;
    let exhaleGaspDepleted = false;
    let exertionReboundImpulse = 0;

    const hasReserve = this.holdBreathActive
      ? this.holdBreathRemainingSec > 0.001
      : this.holdBreathRemainingSec > 0.15;
    const canEngageHold =
      opts.isAds &&
      opts.wantsHoldBreath &&
      !opts.isSprinting &&
      this.holdBreathLockoutSec <= 0 &&
      hasReserve &&
      opts.stamina > 0.12;

    if (canEngageHold) {
      if (!this.holdBreathActive) {
        this.holdBreathActive = true;
        this.lowBreathPulseTimerSec = 0.25;
        triggerInhale = true;
      }
      this.holdBreathHeldDurationSec += delta;
      this.holdBreathRemainingSec = Math.max(0, this.holdBreathRemainingSec - delta);

      const reserveFrac = this.holdBreathRemainingSec / HOLD_BREATH_MAX_SEC;
      if (reserveFrac < 0.35 && this.holdBreathRemainingSec > 0.001) {
        this.lowBreathPulseTimerSec -= delta;
        if (this.lowBreathPulseTimerSec <= 0) {
          const urgency = THREE.MathUtils.clamp((0.35 - reserveFrac) / 0.35, 0, 1);
          triggerLowBreathPulse = true;
          lowBreathPulseIntensity = 0.45 + urgency * 0.55;
          this.lowBreathPulseTimerSec = THREE.MathUtils.lerp(0.92, 0.58, urgency);
        }
      }

      if (this.holdBreathRemainingSec <= 0.001) {
        // Depleted full 7.0s breath hold -> sharp gasp + exertion rebound + 3.0s cooldown lockout
        this.holdBreathActive = false;
        this.holdBreathLockoutSec = HOLD_BREATH_COOLDOWN_SEC;
        this.holdBreathReboundSec = HOLD_BREATH_REBOUND_DURATION_SEC;
        exertionReboundImpulse = 0.32;
        triggerExhaleGasp = true;
        exhaleGaspDepleted = true;
        this.holdBreathHeldDurationSec = 0;
      }
    } else {
      if (this.holdBreathActive) {
        // Released early -> soft exhale + mild proportional rebound if held >= 0.35s
        this.holdBreathActive = false;
        if (this.holdBreathHeldDurationSec >= 0.35) {
          const frac = THREE.MathUtils.clamp(this.holdBreathHeldDurationSec / HOLD_BREATH_MAX_SEC, 0.15, 1.0);
          this.holdBreathReboundSec = HOLD_BREATH_REBOUND_DURATION_SEC * (0.35 + 0.65 * frac);
          exertionReboundImpulse = 0.10 + 0.16 * frac;
          triggerExhaleGasp = true;
          exhaleGaspDepleted = false;
        }
        this.holdBreathHeldDurationSec = 0;
      }

      // Recover breath reserve smoothly (slower during post-depletion cooldown, faster once breathing stabilizes)
      const baseRate = this.holdBreathLockoutSec > 0 ? 0.52 : 0.92;
      const recoveryRate = (baseRate + 0.38 * opts.stamina) * (this.hydration < 25 ? 0.72 : 1.0);
      this.holdBreathRemainingSec = Math.min(
        HOLD_BREATH_MAX_SEC,
        this.holdBreathRemainingSec + recoveryRate * delta,
      );
    }

    // Subtle diegetic edge vignette (focus darkening -> low-O2 gentle edge pulse -> cooldown taper)
    this.breathVignettePhase = (this.breathVignettePhase + delta) % 1000;
    let targetBreathVignette = 0;
    if (this.holdBreathActive) {
      const reserveFrac = this.holdBreathRemainingSec / HOLD_BREATH_MAX_SEC;
      const lowUrgency = reserveFrac < 0.35 ? THREE.MathUtils.clamp((0.35 - reserveFrac) / 0.35, 0, 1) : 0;
      const lowPulse = lowUrgency * (0.28 + 0.24 * (0.5 + 0.5 * Math.sin(this.breathVignettePhase * 7.2)));
      targetBreathVignette = THREE.MathUtils.clamp(0.38 + lowPulse, 0, 0.92);
    } else if (this.holdBreathLockoutSec > 0) {
      const cdFrac = this.holdBreathLockoutSec / HOLD_BREATH_COOLDOWN_SEC;
      targetBreathVignette = cdFrac * (0.22 + 0.16 * (0.5 + 0.5 * Math.sin(this.breathVignettePhase * 5.6)));
    }
    this.breathVignette = THREE.MathUtils.damp(this.breathVignette, targetBreathVignette, 7.0, delta);

    // 3. Low Energy / Hydration Diegetic Modifiers & Audio Cues
    const lowHungerFrac = this.hunger < 35 ? (35 - this.hunger) / 35 : 0;
    const lowHydrationFrac = this.hydration < 35 ? (35 - this.hydration) / 35 : 0;
    const combinedDeficit = Math.max(lowHungerFrac, lowHydrationFrac * 1.05);

    // Hold-breath 0% sway suppression is handled smoothly by BodycamController (1 - holdBreathBlend)
    let swayAmpMult = 1.0 + combinedDeficit * 0.42;
    if (!this.holdBreathActive && this.holdBreathReboundSec > 0) {
      const reboundFrac = this.holdBreathReboundSec / HOLD_BREATH_REBOUND_DURATION_SEC;
      swayAmpMult *= 1.0 + reboundFrac * 0.45;
    }

    const staminaDrainMult = 1.0 + lowHydrationFrac * 0.45 + lowHungerFrac * 0.25;
    const staminaRegenMult = THREE.MathUtils.clamp(1.0 - lowHydrationFrac * 0.48 - lowHungerFrac * 0.32, 0.32, 1.0);
    const staminaCapMult = THREE.MathUtils.clamp(1.0 - combinedDeficit * 0.45, 0.42, 1.0);
    const exertionRateMult = 1.0 + combinedDeficit * 0.45;
    const moveSpeedMult = this.hunger <= 1 || this.hydration <= 1 ? 0.84 : 1.0 - combinedDeficit * 0.08;
    const canSprintVitals = this.hunger > 3 && this.hydration > 3;
    const fatigueBreathSeverity = THREE.MathUtils.clamp(
      combinedDeficit * 0.55 + (this.holdBreathReboundSec > 0 ? 0.38 : 0),
      0,
      0.85,
    );

    // Subtle periodic audio cues for low hunger / hydration
    let triggerStomachGrowl = false;
    let triggerFatigueSigh = false;

    if (this.hunger < 35) {
      this.stomachCueTimerSec -= delta;
      if (this.stomachCueTimerSec <= 0) {
        triggerStomachGrowl = true;
        this.stomachCueTimerSec = 20 + Math.random() * 14 - lowHungerFrac * 6;
      }
    } else {
      this.stomachCueTimerSec = Math.min(this.stomachCueTimerSec, 12);
    }

    if (this.hydration < 35) {
      this.fatigueCueTimerSec -= delta;
      if (this.fatigueCueTimerSec <= 0) {
        triggerFatigueSigh = true;
        this.fatigueCueTimerSec = 22 + Math.random() * 14 - lowHydrationFrac * 6;
      }
    } else {
      this.fatigueCueTimerSec = Math.min(this.fatigueCueTimerSec, 14);
    }

    // 4. Dynamic Cardiovascular Model (movement + exertion + trauma + combat stress + hold-breath)
    const health = opts.health ?? 100;
    if (health <= 0) {
      this.heartRateBpm = THREE.MathUtils.damp(this.heartRateBpm, 0, 5.0, delta);
      if (this.heartRateBpm < 2) this.heartRateBpm = 0;
      this.heartStress = 1;
      this.adrenalineStress = 0;
    } else {
      const moveRatio = THREE.MathUtils.clamp(
        opts.moveSpeedRatio ?? (opts.isSprinting ? 1.0 : opts.isMoving ? 0.45 : 0),
        0,
        1.25,
      );
      const exertion = THREE.MathUtils.clamp(opts.exertion ?? 0, 0, 1);
      const staminaDeficit = THREE.MathUtils.clamp(1 - opts.stamina, 0, 1);
      const healthDeficit = THREE.MathUtils.clamp((100 - health) / 100, 0, 1);
      const threat = THREE.MathUtils.clamp(opts.threatLevel ?? 0, 0, 1);
      const traumaPulse = THREE.MathUtils.clamp(opts.heartbeatSeverity ?? 0, 0, 1);

      // Decay acute adrenaline stress gradually (slower decay under active threat)
      const adrenalineDecay = threat > 0.15 ? 0.045 : 0.085;
      this.adrenalineStress = Math.max(0, this.adrenalineStress - adrenalineDecay * delta);

      // Track prolonged stillness: settle around ~85 BPM normally, only dropping toward ~70 BPM after staying still
      const isCalmAndStill =
        !opts.isMoving &&
        !opts.isSprinting &&
        moveRatio < 0.05 &&
        this.adrenalineStress < 0.08 &&
        threat < 0.1 &&
        !opts.heavyBleeding;
      if (isCalmAndStill) {
        this.stillDurationSec = Math.min(24, this.stillDurationSec + delta);
      } else if (opts.isSprinting || this.adrenalineStress > 0.15 || threat > 0.15) {
        this.stillDurationSec = 0;
      } else {
        this.stillDurationSec = Math.max(0, this.stillDurationSec - delta * 2.5);
      }

      const restT = THREE.MathUtils.clamp((this.stillDurationSec - 4.0) / 14.0, 0, 1);
      const restEase = restT * restT * (3 - 2 * restT);
      const deepRestFloor = opts.crouched ? 69 : 71;
      const baseRestingBpm = THREE.MathUtils.lerp(85, deepRestFloor, restEase);

      const movementLoadBpm =
        (opts.isSprinting ? 30 : opts.isMoving ? 8 : 0) +
        moveRatio * 12 +
        enc * (opts.isMoving ? 10 : 3);
      const metabolicLoadBpm = exertion * 32 + staminaDeficit * 22 + combinedDeficit * 10;
      const stressLoadBpm =
        this.adrenalineStress * 34 +
        threat * 28 +
        healthDeficit * 24 +
        traumaPulse * 16 +
        (opts.heavyBleeding ? 18 : opts.lightBleeding ? 8 : 0);

      let breathModBpm = 0;
      if (this.holdBreathActive) {
        // Gentle vagal focus dip while holding breath in ADS
        breathModBpm = -5;
      } else if (this.holdBreathReboundSec > 0) {
        breathModBpm = 10 * (this.holdBreathReboundSec / HOLD_BREATH_REBOUND_DURATION_SEC);
      }

      // Subtle physiological respiratory sinus arrhythmia (±1.3 BPM)
      const respRateHz = 0.20 + exertion * 0.42 + this.adrenalineStress * 0.22;
      this.rsaPhase = (this.rsaPhase + delta * respRateHz * Math.PI * 2) % (Math.PI * 2);
      const rsaOffset = this.holdBreathActive ? 0 : Math.sin(this.rsaPhase) * 1.3;

      const targetBpm = THREE.MathUtils.clamp(
        baseRestingBpm + movementLoadBpm + metabolicLoadBpm + stressLoadBpm + breathModBpm + rsaOffset,
        62,
        186,
      );

      // Realistic cardiovascular inertia: gradual climb (~0.28/s), slow parasympathetic recovery (~0.11/s)
      const rising = targetBpm > this.heartRateBpm;
      const dampLambda = rising
        ? this.adrenalineStress > 0.35
          ? 0.45
          : 0.28
        : 0.11;
      this.heartRateBpm = THREE.MathUtils.damp(this.heartRateBpm, targetBpm, dampLambda, delta);

      const bpmStress = THREE.MathUtils.clamp((this.heartRateBpm - 84) / 92, 0, 1);
      const targetStress = THREE.MathUtils.clamp(
        Math.max(bpmStress, this.adrenalineStress * 0.8, threat * 0.7, opts.heavyBleeding ? 0.78 : 0),
        0,
        1,
      );
      this.heartStress = THREE.MathUtils.damp(this.heartStress, targetStress, 1.4, delta);
    }

    return {
      swayAmpMult,
      staminaDrainMult,
      staminaRegenMult,
      staminaCapMult,
      exertionRateMult,
      moveSpeedMult,
      fatigueBreathSeverity,
      canSprintVitals,
      exertionReboundImpulse,
      breathVignette: this.breathVignette,
      triggerInhale,
      triggerLowBreathPulse,
      lowBreathPulseIntensity,
      triggerExhaleGasp,
      exhaleGaspDepleted,
      triggerStomachGrowl,
      triggerFatigueSigh,
    };
  }

  /**
   * Computes flashlight dimming and organic sub-15% battery flicker.
   */
  public evaluateFlashlight(
    delta: number,
    battery: number,
    flashlightOn: boolean,
  ): { nextBattery: number; render: FlashlightRenderState } {
    if (!flashlightOn) {
      this.lastBatteryFlickering = false;
      return {
        nextBattery: battery,
        render: { intensity: 0, flickering: false, diedThisFrame: false },
      };
    }

    const nextBattery = Math.max(0, battery - delta * 0.0046);
    if (nextBattery <= 0.001) {
      this.lastBatteryFlickering = false;
      return {
        nextBattery: 0,
        render: { intensity: 0, flickering: false, diedThisFrame: true },
      };
    }

    if (nextBattery >= 0.15) {
      this.lastBatteryFlickering = false;
      return {
        nextBattery,
        render: { intensity: 5.8, flickering: false, diedThisFrame: false },
      };
    }

    // Below 15%: beam gradually dims and exhibits realistic LED brownout flickers
    this.flickerPhase += delta * (14 + (0.15 - nextBattery) * 90);
    const lowRatio = THREE.MathUtils.clamp(nextBattery / 0.15, 0, 1);
    const baseIntensity = THREE.MathUtils.lerp(1.75, 4.9, lowRatio);

    const wave =
      Math.sin(this.flickerPhase * 1.7) * 0.5 +
      Math.sin(this.flickerPhase * 4.3 + 1.1) * 0.35 +
      Math.cos(this.flickerPhase * 9.1) * 0.15;
    const brownoutThresh = THREE.MathUtils.lerp(0.18, 0.62, lowRatio);
    const isDip = wave > brownoutThresh || Math.random() < (1 - lowRatio) * 0.085;
    const intensity = isDip ? baseIntensity * (0.18 + Math.random() * 0.25) : baseIntensity;

    this.lastBatteryFlickering = true;
    return {
      nextBattery,
      render: { intensity, flickering: true, diedThisFrame: false },
    };
  }

  public consumeItem(itemId: string): {
    consumed: boolean;
    kind: 'food' | 'drink';
    staminaBonus: number;
    summary: string;
  } {
    const spec = ITEMS[itemId];
    if (!spec || (spec.category !== 'food' && spec.category !== 'drink')) {
      return { consumed: false, kind: 'food', staminaBonus: 0, summary: '' };
    }

    const hDelta = spec.hungerRestore ?? 0;
    const tDelta = spec.thirstRestore ?? 0;
    const sBonus = spec.staminaRestore ?? 0;

    this.hunger = THREE.MathUtils.clamp(this.hunger + hDelta, 0, 100);
    this.hydration = THREE.MathUtils.clamp(this.hydration + tDelta, 0, 100);

    const parts: string[] = [];
    if (hDelta > 0) parts.push(`+${hDelta} Energy`);
    if (tDelta > 0) parts.push(`+${tDelta} Hydration`);
    else if (tDelta < 0) parts.push(`${tDelta} Hydration`);

    return {
      consumed: true,
      kind: spec.category,
      staminaBonus: sBonus,
      summary: `${spec.shortName}: ${parts.join(', ')}`,
    };
  }

  public buildSnapshot(): VitalsSnapshotState {
    return {
      hunger: Math.round(this.hunger),
      hydration: Math.round(this.hydration),
      holdBreathActive: this.holdBreathActive,
      holdBreathRemainingSec: this.holdBreathRemainingSec,
      holdBreathMaxSec: HOLD_BREATH_MAX_SEC,
      holdBreathReboundSec: this.holdBreathReboundSec,
      batteryFlickering: this.lastBatteryFlickering,
      heartRateBpm: Math.round(this.heartRateBpm),
      heartStress: this.heartStress,
    };
  }

  public exportSaveState(): VitalsSaveState {
    return {
      hunger: Math.round(this.hunger * 10) / 10,
      hydration: Math.round(this.hydration * 10) / 10,
      holdBreathRemainingSec: Math.round(this.holdBreathRemainingSec * 100) / 100,
    };
  }

  public loadSaveState(save: VitalsSaveState | undefined): void {
    this.reset();
    if (!save) return;
    if (typeof save.hunger === 'number' && Number.isFinite(save.hunger)) {
      this.hunger = THREE.MathUtils.clamp(save.hunger, 0, 100);
    }
    if (typeof save.hydration === 'number' && Number.isFinite(save.hydration)) {
      this.hydration = THREE.MathUtils.clamp(save.hydration, 0, 100);
    }
    if (typeof save.holdBreathRemainingSec === 'number' && Number.isFinite(save.holdBreathRemainingSec)) {
      this.holdBreathRemainingSec = THREE.MathUtils.clamp(save.holdBreathRemainingSec, 0, HOLD_BREATH_MAX_SEC);
    }
  }
}

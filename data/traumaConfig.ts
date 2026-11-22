export type LimbId = 'head' | 'thorax' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';

export const LIMB_IDS: readonly LimbId[] = [
  'head',
  'thorax',
  'leftArm',
  'rightArm',
  'leftLeg',
  'rightLeg',
] as const;

export interface LimbConfig {
  id: LimbId;
  label: string;
  shortLabel: string;
  maxHp: number;
  vital: boolean;
  /** Fraction of excess/post-blackout damage overflowing to remaining non-zero limbs */
  overflowMult: number;
  /** Kinetic energy (Joules) threshold to trigger a fracture on blunt/bullet/fall trauma */
  fractureThresholdJ: number;
  /** Kinetic energy (Joules) threshold to trigger a heavy bleed */
  heavyBleedThresholdJ: number;
}

export const LIMB_CONFIGS: Record<LimbId, LimbConfig> = {
  head: {
    id: 'head',
    label: 'Head',
    shortLabel: 'HD',
    maxHp: 35,
    vital: true,
    overflowMult: 0,
    fractureThresholdJ: 999999,
    heavyBleedThresholdJ: 190,
  },
  thorax: {
    id: 'thorax',
    label: 'Thorax',
    shortLabel: 'TX',
    maxHp: 85,
    vital: true,
    overflowMult: 0,
    fractureThresholdJ: 999999,
    heavyBleedThresholdJ: 260,
  },
  leftArm: {
    id: 'leftArm',
    label: 'Left Arm',
    shortLabel: 'LA',
    maxHp: 60,
    vital: false,
    overflowMult: 0.7,
    fractureThresholdJ: 320,
    heavyBleedThresholdJ: 220,
  },
  rightArm: {
    id: 'rightArm',
    label: 'Right Arm',
    shortLabel: 'RA',
    maxHp: 60,
    vital: false,
    overflowMult: 0.7,
    fractureThresholdJ: 320,
    heavyBleedThresholdJ: 220,
  },
  leftLeg: {
    id: 'leftLeg',
    label: 'Left Leg',
    shortLabel: 'LL',
    maxHp: 65,
    vital: false,
    overflowMult: 1.0,
    fractureThresholdJ: 290,
    heavyBleedThresholdJ: 210,
  },
  rightLeg: {
    id: 'rightLeg',
    label: 'Right Leg',
    shortLabel: 'RL',
    maxHp: 65,
    vital: false,
    overflowMult: 1.0,
    fractureThresholdJ: 290,
    heavyBleedThresholdJ: 210,
  },
};

export const TOTAL_LIMB_MAX_HP =
  LIMB_CONFIGS.head.maxHp +
  LIMB_CONFIGS.thorax.maxHp +
  LIMB_CONFIGS.leftArm.maxHp +
  LIMB_CONFIGS.rightArm.maxHp +
  LIMB_CONFIGS.leftLeg.maxHp +
  LIMB_CONFIGS.rightLeg.maxHp; // 370 HP

/**
 * Hard upper/lower bounds on trauma modifiers so severe injuries feel palpable
 * without creating unplayable visual noise.
 */
export const TRAUMA_LIMITS = {
  minMoveSpeedMult: 0.38,
  minMoveAccelMult: 0.42,
  minLimpCadenceScale: 0.58,
  maxLimpDip: 1.0,
  maxSwayAmpMult: 2.25,
  maxTremorRad: 0.0042,
  minAdsSpeedMult: 0.45,
  maxRecoilMult: 1.75,
  minReloadSpeedMult: 0.625, // 1 / 1.6 -> up to 1.6x slower reload when blacked out
  minStaminaCap: 0.35,
  maxDesaturation: 0.68,
  maxConcussionBlur: 0.85,
  maxChromaticSpike: 0.011,
  maxArterialVignette: 0.92,
} as const;

export const TRAUMA_RATE_CONSTANTS = {
  lightBleedHpPerSec: 0.55,
  heavyBleedHpPerSec: 1.45,
  blackedSystemicBleedScale: 0.68,
  lightBleedDecalIntervalSec: 2.4,
  heavyBleedDecalIntervalSec: 1.05,
  painkillerDurationSec: 90,
  tinnitusDecayPerSec: 0.34,
  muffleDecayPerSec: 0.42,
  blurDecayPerSec: 0.72,
  chromaticDecayPerSec: 0.95,
} as const;

/** Flat POD struct per limb (zero methods/classes, C++/SDL3 portable layout) */
export interface LimbState {
  hp: number;
  maxHp: number;
  vital: boolean;
  lightBleed: boolean;
  heavyBleed: boolean;
  fracture: boolean;
  blackedOut: boolean;
}

/** Flat POD modifiers struct mutated in place and read across systems */
export interface TraumaModifiers {
  moveSpeedMult: number;
  moveAccelMult: number;
  canSprint: boolean;
  leftLegImpairment: number;
  rightLegImpairment: number;
  /** Signed asymmetric dip (-1 left leg injured .. +1 right leg injured) */
  asymmetricLimpDip: number;
  limpCadenceScale: number;

  swayAmpMult: number;
  tremorAmp: number;
  adsSpeedMult: number;
  recoilMult: number;
  reloadSpeedMult: number;

  staminaCap: number;
  raggedBreathSeverity: number;
  heartbeatSeverity: number;

  tinnitusLevel: number;
  muffleLevel: number;
  concussionBlur: number;
  chromaticSpike: number;
  desaturation: number;
  arterialVignette: number;

  painkillerRemainingSec: number;
  anyLightBleed: boolean;
  anyHeavyBleed: boolean;
  anyFracture: boolean;
  alive: boolean;
  normalizedHealth: number;

  pendingFlinchPitch: number;
  pendingFlinchYaw: number;
}

export interface TraumaSaveState {
  limbs: Record<LimbId, LimbState>;
  painkillerRemainingSec: number;
}

export function createDefaultLimbStates(): Record<LimbId, LimbState> {
  return {
    head: { hp: LIMB_CONFIGS.head.maxHp, maxHp: LIMB_CONFIGS.head.maxHp, vital: true, lightBleed: false, heavyBleed: false, fracture: false, blackedOut: false },
    thorax: { hp: LIMB_CONFIGS.thorax.maxHp, maxHp: LIMB_CONFIGS.thorax.maxHp, vital: true, lightBleed: false, heavyBleed: false, fracture: false, blackedOut: false },
    leftArm: { hp: LIMB_CONFIGS.leftArm.maxHp, maxHp: LIMB_CONFIGS.leftArm.maxHp, vital: false, lightBleed: false, heavyBleed: false, fracture: false, blackedOut: false },
    rightArm: { hp: LIMB_CONFIGS.rightArm.maxHp, maxHp: LIMB_CONFIGS.rightArm.maxHp, vital: false, lightBleed: false, heavyBleed: false, fracture: false, blackedOut: false },
    leftLeg: { hp: LIMB_CONFIGS.leftLeg.maxHp, maxHp: LIMB_CONFIGS.leftLeg.maxHp, vital: false, lightBleed: false, heavyBleed: false, fracture: false, blackedOut: false },
    rightLeg: { hp: LIMB_CONFIGS.rightLeg.maxHp, maxHp: LIMB_CONFIGS.rightLeg.maxHp, vital: false, lightBleed: false, heavyBleed: false, fracture: false, blackedOut: false },
  };
}

export function createNeutralTraumaModifiers(): TraumaModifiers {
  return {
    moveSpeedMult: 1.0,
    moveAccelMult: 1.0,
    canSprint: true,
    leftLegImpairment: 0,
    rightLegImpairment: 0,
    asymmetricLimpDip: 0,
    limpCadenceScale: 1.0,
    swayAmpMult: 1.0,
    tremorAmp: 0,
    adsSpeedMult: 1.0,
    recoilMult: 1.0,
    reloadSpeedMult: 1.0,
    staminaCap: 1.0,
    raggedBreathSeverity: 0,
    heartbeatSeverity: 0,
    tinnitusLevel: 0,
    muffleLevel: 0,
    concussionBlur: 0,
    chromaticSpike: 0,
    desaturation: 0,
    arterialVignette: 0,
    painkillerRemainingSec: 0,
    anyLightBleed: false,
    anyHeavyBleed: false,
    anyFracture: false,
    alive: true,
    normalizedHealth: 100,
    pendingFlinchPitch: 0,
    pendingFlinchYaw: 0,
  };
}

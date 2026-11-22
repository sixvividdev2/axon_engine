export type AiArchetypeId = 'infected_walker' | 'infected_stalker';

export interface AiArchetypeSpec {
  id: AiArchetypeId;
  label: string;
  maxHp: number;
  headshotMultiplier: number;
  /** Multiplier on incoming acoustic event radius (1.0 = hears exact radius, 1.35 = hyper-sensitive) */
  hearingSensitivity: number;
  /** Minimum sound intensity ratio (0..1) at distance before alerting */
  hearingThreshold: number;
  /** Base daylight/fog vision distance in meters */
  visionRangeM: number;
  /** Full vision cone angle in degrees */
  visionConeDeg: number;
  /** Vision multiplier if player is crouched */
  crouchVisionMult: number;
  /** Vision multiplier if player flashlight beam illuminates near zombie */
  flashlightDetectionMult: number;
  wanderSpeedMps: number;
  investigateSpeedMps: number;
  chaseSpeedMps: number;
  attackDamage: number;
  bleedChance: number;
  attackRangeM: number;
  attackCooldownSec: number;
  /** Kinetic energy in Joules required on torso hit to stagger */
  staggerThresholdJ: number;
  /** Visual scale & tint */
  bodyScale: number;
  skinColorHex: number;
  clothColorHex: number;
  eyeGlowHex: number;
}

export const AI_ARCHETYPES: Record<AiArchetypeId, AiArchetypeSpec> = {
  infected_walker: {
    id: 'infected_walker',
    label: 'Zone Walker',
    maxHp: 115,
    headshotMultiplier: 3.1,
    hearingSensitivity: 1.0,
    hearingThreshold: 0.14,
    visionRangeM: 18,
    visionConeDeg: 95,
    crouchVisionMult: 0.52,
    flashlightDetectionMult: 2.35,
    wanderSpeedMps: 0.95,
    investigateSpeedMps: 1.65,
    chaseSpeedMps: 3.35,
    attackDamage: 22,
    bleedChance: 0.42,
    attackRangeM: 1.55,
    attackCooldownSec: 1.35,
    staggerThresholdJ: 420,
    bodyScale: 1.0,
    skinColorHex: 0x6c7268,
    clothColorHex: 0x323632,
    eyeGlowHex: 0x998e70,
  },
  infected_stalker: {
    id: 'infected_stalker',
    label: 'Feral Stalker',
    maxHp: 90,
    headshotMultiplier: 3.5,
    hearingSensitivity: 1.38,
    hearingThreshold: 0.09,
    visionRangeM: 22,
    visionConeDeg: 110,
    crouchVisionMult: 0.58,
    flashlightDetectionMult: 2.6,
    wanderSpeedMps: 1.25,
    investigateSpeedMps: 2.35,
    chaseSpeedMps: 4.55,
    attackDamage: 18,
    bleedChance: 0.65,
    attackRangeM: 1.65,
    attackCooldownSec: 0.95,
    staggerThresholdJ: 320,
    bodyScale: 0.94,
    skinColorHex: 0x565c58,
    clothColorHex: 0x25282c,
    eyeGlowHex: 0xb87b58,
  },
};

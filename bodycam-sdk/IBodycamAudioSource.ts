import * as THREE from 'three';
import { BodycamMeleeAttackType, BodycamSurfaceMaterial } from './types';

export type BodycamGearRattleKind = 'step' | 'crouch' | 'landing' | 'weapon_swap' | 'vault' | 'melee';

export type BodycamBreathCueKind = 'inhale' | 'exhale' | 'exhale_depleted' | 'low_o2_pulse';

export type BodycamWeaponAudioCue =
  | 'mag_out'
  | 'mag_in'
  | 'rack'
  | 'bolt_open'
  | 'bolt_pull'
  | 'bolt_push'
  | 'bolt_lock'
  | 'mode_toggle'
  | 'ads_rustle'
  | 'dryfire'
  | 'fire'
  | 'gunsmith_snap'
  | 'suppressor_twist'
  | 'suppressor_lock';

export interface BodycamWeaponCueOptions {
  position?: Readonly<THREE.Vector3>;
  weightClass?: 'pistol' | 'carbine' | 'heavy_rifle';
  caliberId?: string;
  suppressed?: boolean;
  isSubsonic?: boolean;
  muzzleComp?: boolean;
  intensity?: number;
}

/**
 * Portable audio source contract for the Bodycam SDK.
 * Allows any host game engine (or the built-in `BodycamAudio` synthesizer)
 * to fulfill surface-aware footsteps, gear rattle, vault/mantle foley, melee/kick impacts,
 * mechanical weapon cues, ricochets, glass shatters, and diegetic hold-breath cues.
 */
export interface IBodycamAudioSource {
  updateListener(
    position: Readonly<THREE.Vector3>,
    forward: Readonly<THREE.Vector3>,
    up: Readonly<THREE.Vector3>,
  ): void;

  setInteriorAcoustics(
    isIndoor: boolean,
    material: 'concrete' | 'wood' | 'metal' | 'outdoor',
  ): void;

  playFootstep(surface: BodycamSurfaceMaterial, intensity?: number): void;

  playGearRattle(kind: BodycamGearRattleKind, intensity?: number): void;

  /** Surface-matched gloved hand brace/slap against a concrete, metal, or wood ledge */
  playHandSlap(surface: BodycamSurfaceMaterial, intensity?: number): void;

  /** Surface-matched tactical boot scrape/scuff against an obstacle face during climb/mantle */
  playBootScuff(surface: BodycamSurfaceMaterial, intensity?: number): void;

  /** Tempered glass pane shatter when vaulting through or shooting/kicking a breakable window */
  playGlassShatter(pos: Readonly<THREE.Vector3>, intensity?: number): void;

  /** Supersonic spatialized grazing ricochet whine / zing */
  playRicochet?(
    pos: Readonly<THREE.Vector3>,
    speedMps: number,
    surface: BodycamSurfaceMaterial,
  ): void;

  /** Air whip / fabric snap whoosh on jab, cross, rifle bash, or tactical push-kick */
  playMeleeWhoosh?(attackType: BodycamMeleeAttackType): void;

  /** Visceral meaty blunt thud or heavy boot slam on impact */
  playMeleeImpact?(
    pos: Readonly<THREE.Vector3>,
    attackType: BodycamMeleeAttackType,
    surface: BodycamSurfaceMaterial | 'flesh',
    intensity?: number,
  ): void;

  /** Mechanical firearm foley & gunshot cues synced to weapon animations */
  playWeaponCue?(cue: BodycamWeaponAudioCue, options?: BodycamWeaponCueOptions): void;

  /** Diegetic hold-breath audio cues: inhale, soft exhale, depleted gasp, and low-O2 cardiac thump */
  playBreathCue?(kind: BodycamBreathCueKind, intensity?: number): void;

  /** Metallic grenade safety-pin yank (does NOT ignite fuse) */
  playGrenadePinPull?(): void;

  /** Spring-loaded safety lever (spoon) fly-off + percussion primer ignition snap */
  playGrenadeLeverSnap?(): void;

  /** Spatialized grenade/canister floor & wall bounce clink */
  playGrenadeBounce?(pos: Readonly<THREE.Vector3>, speed?: number): void;

  /** Spatialized tactical ordnance detonation audio */
  playExplosion?(
    pos: Readonly<THREE.Vector3>,
    kind: 'frag' | 'flash' | 'smoke' | 'thermite',
  ): void;

  /** Concussive ear-muffle low-pass dip + realistic high-frequency tinnitus fade */
  playFlashbangTinnitus?(intensity: number): void;

  /** Mechanical LPVO magnification ring throw-lever detent click */
  playZoomRatchetClick?(zoomLevel?: number): void;

  /** Tactile 0.1 MRAD scope elevation/windage turret click */
  playTurretClick?(up?: boolean): void;
}


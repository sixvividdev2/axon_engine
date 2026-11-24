import * as THREE from 'three';
import {
  BallisticFlybyContext,
  BallisticsSolver,
  BallisticImpactEvent,
  BodycamAudio,
  BodycamWeaponProfile,
  computeTargetHingeAngularImpulse,
  IBodycamWorldAdapter,
  TerminalOutcome,
} from '../bodycam-sdk';
import { BallisticMaterialId } from '../data/ballisticMaterials';
import { AmmoVariantDef } from '../data/calibers';
import { PaperShootingTarget, ReactiveSteelTarget } from './GymWorld';

export interface GymBallisticHitInfo {
  targetLabel: string;
  caliberLabel: string;
  ammoLabel: string;
  outcome: TerminalOutcome;
  material: BallisticMaterialId;
  grazingAngleDeg: number;
  penetrationThicknessM: number;
  distanceM: number;
  impactSpeedMps: number;
  energyJoules: number;
  isSteel: boolean;
  timestampMs: number;
}

/**
 * Coupled Military-Simulation Ballistics Engine for the Bodycam Calibration Gym.
 * Wraps the portable zero-GC `BallisticsSolver` in `src/bodycam-sdk/` and connects
 * terminal impact events (Ricochet, Fragmentation, Penetration, Stop) to reactive
 * Zone-5 steel silhouettes, penetration barriers, spatial audio, and HUD telemetry.
 */
export class GymBallistics {
  private readonly scene: THREE.Scene;
  private readonly audio: BodycamAudio;
  private readonly solver: BallisticsSolver;
  private readonly steelById = new Map<string, ReactiveSteelTarget>();
  private readonly paperById = new Map<string, PaperShootingTarget>();

  constructor(
    scene: THREE.Scene,
    audio: BodycamAudio,
    steelTargets: ReactiveSteelTarget[],
    paperTargets: PaperShootingTarget[],
  ) {
    this.scene = scene;
    this.audio = audio;
    this.solver = new BallisticsSolver(scene);
    for (const s of steelTargets) this.steelById.set(s.id, s);
    for (const p of paperTargets) this.paperById.set(p.id, p);
  }

  public fireRound(
    muzzlePos: Readonly<THREE.Vector3>,
    muzzleDir: Readonly<THREE.Vector3>,
    profile: Readonly<BodycamWeaponProfile>,
    ammo: Readonly<AmmoVariantDef>,
    attachmentVelocityMult = 1.0,
  ): void {
    if (ammo.baseVelocityMs <= 0) return;
    this.solver.spawnShot({
      origin: muzzlePos,
      direction: muzzleDir,
      ammo,
      weaponId: profile.id,
      barrelVelocityMult: profile.barrelVelocityMult ?? 1.0,
      attachmentVelocityMult,
      weaponSpreadMOA: profile.spreadMOA,
      audio: this.audio,
    });
  }

  public clear(): void {
    this.solver.clearEffects();
  }

  public update(
    dt: number,
    adapter: IBodycamWorldAdapter,
    onHit?: (info: GymBallisticHitInfo) => void,
    flybyCtx?: BallisticFlybyContext,
  ): void {
    const clampedDt = Math.min(dt, 0.05);
    this.solver.update(
      clampedDt,
      adapter,
      (ev) => {
        this.handleSolverImpact(ev, onHit);
      },
      flybyCtx,
    );
  }

  private handleSolverImpact(
    ev: Readonly<BallisticImpactEvent>,
    onHit?: (info: GymBallisticHitInfo) => void,
  ): void {
    const hitObj = ev.object;
    const targetKind = hitObj?.userData?.gymTargetKind as string | undefined;
    const targetId = hitObj?.userData?.gymTargetId as string | undefined;
    const customLabel = hitObj?.userData?.gymTargetLabel as string | undefined;

    if (ev.material === 'glass') {
      this.audio.playGlassShatter(ev.point, 1.0);
    } else if (targetKind === 'steel_plate' && targetId) {
      const st = this.steelById.get(targetId);
      if (st) {
        st.hitAngVel += computeTargetHingeAngularImpulse({
          pivot: st.pivot,
          hitPointWorld: ev.point,
          incomingDir: ev.incomingDir,
          impactSpeedMs: ev.impactSpeedMs,
          bulletMassGrams: ev.ammo.bulletMassGrams,
          pellets: ev.ammo.pellets,
          outcome: ev.outcome,
          outgoingDir: ev.outgoingDir,
          effectiveInertia: 0.24,
          impulseScale: 0.72,
          minDeltaRadSec: 1.6,
          maxDeltaRadSec: 10.5,
        });
        st.hitFlashTimer = 0.14;
        this.audio.playImpact(ev.point, 'steel_plate');
      }
    } else if (targetKind === 'paper') {
      this.audio.playImpact(ev.point, 'paper');
    } else if (ev.material === 'steel') {
      this.audio.playImpact(ev.point, 'metal');
    } else if (ev.material === 'water') {
      this.audio.playImpact(ev.point, 'puddle');
    } else if (ev.material === 'wood') {
      this.audio.playImpact(ev.point, 'wood');
    } else {
      this.audio.playImpact(ev.point, 'concrete');
    }

    const isImportantTarget =
      Boolean(targetKind) ||
      ev.outcome === 'ricochet' ||
      ev.outcome === 'penetrate' ||
      ev.outcome === 'fragment';

    if (!isImportantTarget || !onHit) return;

    let targetLabel = customLabel ?? ev.material.toUpperCase();
    if (targetKind === 'steel_plate' && targetId) {
      const st = this.steelById.get(targetId);
      if (st) targetLabel = `${st.label} (${st.distanceLabel})`;
    } else if (targetKind === 'paper' && targetId) {
      const pt = this.paperById.get(targetId);
      if (pt) targetLabel = `${pt.label} (${pt.distanceLabel})`;
    }

    onHit({
      targetLabel,
      caliberLabel: ev.ammo.caliberId.toUpperCase(),
      ammoLabel: ev.ammo.shortName,
      outcome: ev.outcome,
      material: ev.material,
      grazingAngleDeg: ev.grazingAngleDeg,
      penetrationThicknessM: ev.penetrationThicknessM,
      distanceM: ev.distanceM,
      impactSpeedMps: ev.impactSpeedMs,
      energyJoules: ev.impactEnergyJ,
      isSteel: ev.material === 'steel',
      timestampMs: performance.now(),
    });
  }

  public dispose(): void {
    this.solver.dispose();
    this.scene.remove(this.solver.group);
  }
}

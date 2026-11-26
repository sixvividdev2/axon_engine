import * as THREE from 'three';
import { poseHostileCombatant } from '../bodycam-sdk';
import { ArmedCinematicOperator, buildArmedCinematicOperator } from './CinematicVehiclesAndRigs';

export type GroundTargetKind = 'tank' | 'apc' | 'infantry';
export type GroundTargetOutcome = 'explode' | 'neutralize';
export type GroundTargetState = 'active' | 'exploded' | 'neutralized';

export interface GroundTargetSpec {
  readonly id: string;
  readonly kind: GroundTargetKind;
  readonly outcome: GroundTargetOutcome;
  readonly role: 'prologue_aerial' | 'prologue_gunner' | 'insertion_gunner';
  readonly startPos: readonly [number, number, number];
  readonly rotY: number;
  readonly moveSpeedMps: number;
  readonly engageStartSec: number;
  readonly engageEndSec: number;
  /** Time (sec) when the target resolves into either 'exploded' or 'neutralized' */
  readonly resolveTimeSec: number;
}

export interface GroundTargetCombatCallbacks {
  onHitSparks?: (worldPos: THREE.Vector3, count: number) => void;
  onExplode?: (worldPos: THREE.Vector3, kind: GroundTargetKind) => void;
  onDisableSmoke?: (worldPos: THREE.Vector3) => void;
  onNeutralize?: (worldPos: THREE.Vector3, kind: GroundTargetKind) => void;
}

export interface ActiveGroundEngagement {
  readonly targetId: string;
  readonly kind: GroundTargetKind;
  readonly outcome: GroundTargetOutcome;
  readonly aimWorldPos: THREE.Vector3;
  readonly isFiring: boolean;
}

export interface GroundTargetSummary {
  readonly id: string;
  readonly kind: GroundTargetKind;
  readonly outcome: GroundTargetOutcome;
  readonly state: GroundTargetState;
}

interface InternalTargetSlot {
  readonly spec: GroundTargetSpec;
  readonly root: THREE.Group;
  readonly turretPivot: THREE.Group | null;
  readonly wheels: THREE.Object3D[];
  readonly armorMats: THREE.MeshStandardMaterial[];
  readonly emissiveMeshes: THREE.Mesh[];
  readonly fireMesh: THREE.Mesh | null;
  readonly infantry: ArmedCinematicOperator | null;
  readonly worldPos: THREE.Vector3;
  readonly aimPos: THREE.Vector3;
  readonly forwardDir: THREE.Vector3;
  state: GroundTargetState;
  downBlend: number;
  damageShake: number;
  lastSparkBucket: number;
  lastSmokeBucket: number;
  baseYaw: number;
}

export interface WarzoneGroundTargetSystem {
  readonly root: THREE.Group;
  /**
   * Advances all ground targets (tanks, APCs, hostile infantry) for the active timeline role,
   * triggers sparks/explosions/disable smoke at exact hit windows, and returns the currently locked
   * target (if any) so the helicopter door gunner tracks and fires directly onto it!
   */
  update: (
    timeSec: number,
    dt: number,
    role: GroundTargetSpec['role'] | null,
    callbacks?: GroundTargetCombatCallbacks,
  ) => ActiveGroundEngagement | null;
  /** Read-only snapshot of every target's current state (for deterministic tests). */
  getTargetSummaries: () => GroundTargetSummary[];
  dispose: () => void;
}

const DEFAULT_GROUND_TARGET_SPECS: readonly GroundTargetSpec[] = [
  // --- Prologue Act 1A Aerial Sweep (0..12s) — engaged by Escort Gunship Valkyrie 2-2 ---
  {
    id: 'tank_aerial_valley',
    kind: 'tank',
    outcome: 'explode',
    role: 'prologue_aerial',
    startPos: [-12, 0, -44],
    rotY: 0.42,
    moveSpeedMps: 1.2,
    engageStartSec: 2.2,
    engageEndSec: 5.1,
    resolveTimeSec: 4.55,
  },
  {
    id: 'apc_aerial_road',
    kind: 'apc',
    outcome: 'neutralize',
    role: 'prologue_aerial',
    startPos: [7.5, 0, -34],
    rotY: -0.22,
    moveSpeedMps: 1.9,
    engageStartSec: 7.2,
    engageEndSec: 10.2,
    resolveTimeSec: 9.1,
  },
  // --- Prologue Act 2 Helicopter Descent (23.8..30.6s) — directly outside open port doorway ---
  {
    id: 'infantry_flank_1',
    kind: 'infantry',
    outcome: 'neutralize',
    role: 'prologue_gunner',
    startPos: [-45.5, 0, -59.5],
    rotY: -1.15,
    moveSpeedMps: 0,
    engageStartSec: 24.0,
    engageEndSec: 25.45,
    resolveTimeSec: 25.0,
  },
  {
    id: 'infantry_flank_2',
    kind: 'infantry',
    outcome: 'neutralize',
    role: 'prologue_gunner',
    startPos: [-43.0, 0, -56.5],
    rotY: -1.35,
    moveSpeedMps: 0,
    engageStartSec: 24.0,
    engageEndSec: 25.55,
    resolveTimeSec: 25.35,
  },
  {
    id: 'apc_west_column',
    kind: 'apc',
    outcome: 'neutralize',
    role: 'prologue_gunner',
    startPos: [-44.5, 0, -45.5],
    rotY: 0.25,
    moveSpeedMps: 1.7,
    engageStartSec: 25.75,
    engageEndSec: 27.45,
    resolveTimeSec: 27.1,
  },
  {
    id: 'tank_valley_lead',
    kind: 'tank',
    outcome: 'explode',
    role: 'prologue_gunner',
    startPos: [-35.5, 0, -28.0],
    rotY: -0.58,
    moveSpeedMps: 0.95,
    engageStartSec: 27.7,
    engageEndSec: 29.45,
    resolveTimeSec: 29.05,
  },
  {
    id: 'apc_ridge_rear',
    kind: 'apc',
    outcome: 'explode',
    role: 'prologue_gunner',
    startPos: [-24.0, 0, -16.0],
    rotY: -0.92,
    moveSpeedMps: 1.35,
    engageStartSec: 29.6,
    engageEndSec: 30.65,
    resolveTimeSec: 30.25,
  },
  // --- Helicopter Insertion Phase 3 (11.1..15.8s) — outside open port doorway on combat approach ---
  {
    id: 'apc_east_flank',
    kind: 'apc',
    outcome: 'neutralize',
    role: 'insertion_gunner',
    startPos: [4.5, 0, -23.5],
    rotY: 0.45,
    moveSpeedMps: 1.6,
    engageStartSec: 11.2,
    engageEndSec: 12.85,
    resolveTimeSec: 12.55,
  },
  {
    id: 'tank_east_ridge',
    kind: 'tank',
    outcome: 'explode',
    role: 'insertion_gunner',
    startPos: [11.0, 0, -13.0],
    rotY: 0.78,
    moveSpeedMps: 0.9,
    engageStartSec: 13.05,
    engageEndSec: 14.75,
    resolveTimeSec: 14.35,
  },
  {
    id: 'infantry_east_1',
    kind: 'infantry',
    outcome: 'neutralize',
    role: 'insertion_gunner',
    startPos: [13.2, 0, -11.2],
    rotY: 1.15,
    moveSpeedMps: 0,
    engageStartSec: 14.85,
    engageEndSec: 15.85,
    resolveTimeSec: 15.45,
  },
];

/**
 * Builds composite 3D hostile Main Battle Tanks, Armored APCs, and IK-posed Hostile Infantry
 * deployed across the warzone valley with mixed explosive & neutralized/disabled outcomes.
 */
export function buildWarzoneGroundTargets(isSoftwareGl: boolean): WarzoneGroundTargetSystem {
  const root = new THREE.Group();
  root.name = 'WarzoneGroundTargets';

  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geos.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    mats.push(m);
    return m;
  };

  // Shared geometries across composite vehicles (zero duplication, crisp silhouette scales)
  const tankHullGeo = trackGeo(new THREE.BoxGeometry(3.3, 0.92, 6.2));
  const tankGlacisGeo = trackGeo(new THREE.BoxGeometry(3.15, 0.54, 1.55));
  const tankTrackGeo = trackGeo(new THREE.BoxGeometry(0.68, 0.82, 6.4));
  const tankSkirtGeo = trackGeo(new THREE.BoxGeometry(0.14, 0.44, 5.9));
  const tankTurretGeo = trackGeo(new THREE.BoxGeometry(2.35, 0.78, 2.85));
  const tankCupolaGeo = trackGeo(new THREE.CylinderGeometry(0.42, 0.48, 0.28, 10));
  const tankBarrelGeo = trackGeo(new THREE.CylinderGeometry(0.085, 0.11, 4.4, 8));
  tankBarrelGeo.rotateX(Math.PI * 0.5);
  const tankEvacGeo = trackGeo(new THREE.CylinderGeometry(0.14, 0.14, 0.75, 8));
  tankEvacGeo.rotateX(Math.PI * 0.5);
  const tankLouverGeo = trackGeo(new THREE.BoxGeometry(2.4, 0.12, 1.55));
  const opticGeo = trackGeo(new THREE.BoxGeometry(0.32, 0.12, 0.1));

  const apcHullGeo = trackGeo(new THREE.BoxGeometry(2.45, 0.85, 5.8));
  const apcUpperGeo = trackGeo(new THREE.BoxGeometry(2.26, 0.78, 4.1));
  const apcNoseGeo = trackGeo(new THREE.BoxGeometry(2.3, 0.62, 1.5));
  const apcTurretGeo = trackGeo(new THREE.BoxGeometry(1.15, 0.52, 1.35));
  const apcCannonGeo = trackGeo(new THREE.CylinderGeometry(0.055, 0.068, 2.25, 8));
  apcCannonGeo.rotateX(Math.PI * 0.5);
  const apcWheelGeo = trackGeo(new THREE.CylinderGeometry(0.54, 0.54, 0.36, 12));
  apcWheelGeo.rotateZ(Math.PI * 0.5);
  const apcHeadlightGeo = trackGeo(new THREE.BoxGeometry(0.3, 0.14, 0.08));

  const fireCoreGeo = trackGeo(new THREE.DodecahedronGeometry(1.05, 0));

  const darkTrackMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x16181a, roughness: 0.92, metalness: 0.18 }),
  );
  const gunMetalMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x1e2328, roughness: 0.44, metalness: 0.72 }),
  );
  const fireMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xf97316, transparent: true, opacity: 0.9 }),
  );

  const slots: InternalTargetSlot[] = [];

  for (const spec of DEFAULT_GROUND_TARGET_SPECS) {
    const group = new THREE.Group();
    group.name = `GroundTarget_${spec.id}`;
    group.position.set(spec.startPos[0], spec.startPos[1], spec.startPos[2]);
    group.rotation.y = spec.rotY;
    root.add(group);

    let turretPivot: THREE.Group | null = null;
    const wheels: THREE.Object3D[] = [];
    const armorMats: THREE.MeshStandardMaterial[] = [];
    const emissiveMeshes: THREE.Mesh[] = [];
    let fireMesh: THREE.Mesh | null = null;
    let infantry: ArmedCinematicOperator | null = null;

    if (spec.kind === 'tank') {
      const armorMat = trackMat(
        new THREE.MeshStandardMaterial({ color: 0x3b4036, roughness: 0.76, metalness: 0.24 }),
      );
      const skirtMat = trackMat(
        new THREE.MeshStandardMaterial({ color: 0x2d322a, roughness: 0.84, metalness: 0.18 }),
      );
      const opticMat = trackMat(
        new THREE.MeshStandardMaterial({
          color: 0xfca5a5,
          emissive: 0xef4444,
          emissiveIntensity: 2.2,
          roughness: 0.2,
        }),
      );
      armorMats.push(armorMat, skirtMat);

      const hull = new THREE.Mesh(tankHullGeo, armorMat);
      hull.position.set(0, 0.86, 0);
      hull.castShadow = !isSoftwareGl;
      hull.receiveShadow = true;

      const glacis = new THREE.Mesh(tankGlacisGeo, armorMat);
      glacis.position.set(0, 0.98, -3.25);
      glacis.rotation.x = 0.34;

      const louvers = new THREE.Mesh(tankLouverGeo, darkTrackMat);
      louvers.position.set(0, 1.35, 1.95);

      const trackL = new THREE.Mesh(tankTrackGeo, darkTrackMat);
      trackL.position.set(-1.52, 0.42, 0);
      const trackR = new THREE.Mesh(tankTrackGeo, darkTrackMat);
      trackR.position.set(1.52, 0.42, 0);

      const skirtL = new THREE.Mesh(tankSkirtGeo, skirtMat);
      skirtL.position.set(-1.86, 0.72, 0);
      const skirtR = new THREE.Mesh(tankSkirtGeo, skirtMat);
      skirtR.position.set(1.86, 0.72, 0);

      group.add(hull, glacis, louvers, trackL, trackR, skirtL, skirtR);

      turretPivot = new THREE.Group();
      turretPivot.position.set(0, 1.56, -0.25);
      group.add(turretPivot);

      const turret = new THREE.Mesh(tankTurretGeo, armorMat);
      turret.castShadow = !isSoftwareGl;
      const cupola = new THREE.Mesh(tankCupolaGeo, skirtMat);
      cupola.position.set(0.45, 0.48, 0.45);
      const barrel = new THREE.Mesh(tankBarrelGeo, gunMetalMat);
      barrel.position.set(0, 0.06, -3.2);
      const evac = new THREE.Mesh(tankEvacGeo, gunMetalMat);
      evac.position.set(0, 0.06, -2.55);
      const optic = new THREE.Mesh(opticGeo, opticMat);
      optic.position.set(-0.62, 0.16, -1.44);
      emissiveMeshes.push(optic);
      turretPivot.add(turret, cupola, barrel, evac, optic);

      fireMesh = new THREE.Mesh(fireCoreGeo, fireMat);
      fireMesh.position.set(0, 1.82, -0.1);
      fireMesh.visible = false;
      group.add(fireMesh);
    } else if (spec.kind === 'apc') {
      const armorMat = trackMat(
        new THREE.MeshStandardMaterial({ color: 0x353b36, roughness: 0.74, metalness: 0.26 }),
      );
      const headlightMat = trackMat(
        new THREE.MeshStandardMaterial({
          color: 0xffedd5,
          emissive: 0xf59e0b,
          emissiveIntensity: 2.4,
          roughness: 0.2,
        }),
      );
      armorMats.push(armorMat);

      const hull = new THREE.Mesh(apcHullGeo, armorMat);
      hull.position.set(0, 0.94, 0);
      hull.castShadow = !isSoftwareGl;
      hull.receiveShadow = true;

      const upper = new THREE.Mesh(apcUpperGeo, armorMat);
      upper.position.set(0, 1.72, 0.45);

      const nose = new THREE.Mesh(apcNoseGeo, armorMat);
      nose.position.set(0, 1.44, -2.35);
      nose.rotation.x = 0.28;

      const hlL = new THREE.Mesh(apcHeadlightGeo, headlightMat);
      hlL.position.set(-0.84, 1.24, -2.92);
      const hlR = new THREE.Mesh(apcHeadlightGeo, headlightMat);
      hlR.position.set(0.84, 1.24, -2.92);
      emissiveMeshes.push(hlL, hlR);

      group.add(hull, upper, nose, hlL, hlR);

      for (const wz of [-1.95, 0.15, 1.95]) {
        for (const wx of [-1.32, 1.32]) {
          const wh = new THREE.Mesh(apcWheelGeo, darkTrackMat);
          wh.position.set(wx, 0.54, wz);
          group.add(wh);
          wheels.push(wh);
        }
      }

      turretPivot = new THREE.Group();
      turretPivot.position.set(0, 2.34, -0.35);
      group.add(turretPivot);

      const turret = new THREE.Mesh(apcTurretGeo, gunMetalMat);
      const cannon = new THREE.Mesh(apcCannonGeo, gunMetalMat);
      cannon.position.set(0, 0.04, -1.65);
      turretPivot.add(turret, cannon);

      fireMesh = new THREE.Mesh(fireCoreGeo, fireMat);
      fireMesh.position.set(0, 2.1, -0.2);
      fireMesh.visible = false;
      group.add(fireMesh);
    } else {
      infantry = buildArmedCinematicOperator({
        operatorId: 'MALE',
        uniformId: 'ffa',
        helmetType: 'mich',
        helmetColor: 'coyote_brown',
        faceGear: 'balaclava',
        weaponId: 'akm_762',
      });
      group.add(infantry.skeleton.root);
      poseHostileCombatant(infantry.skeleton, 0, 0, infantry.weaponMount);
    }

    const forwardDir = new THREE.Vector3(-Math.sin(spec.rotY), 0, -Math.cos(spec.rotY));
    slots.push({
      spec,
      root: group,
      turretPivot,
      wheels,
      armorMats,
      emissiveMeshes,
      fireMesh,
      infantry,
      worldPos: new THREE.Vector3(spec.startPos[0], spec.startPos[1], spec.startPos[2]),
      aimPos: new THREE.Vector3(spec.startPos[0], spec.startPos[1] + 1.4, spec.startPos[2]),
      forwardDir,
      state: 'active',
      downBlend: 0,
      damageShake: 0,
      lastSparkBucket: -1,
      lastSmokeBucket: -1,
      baseYaw: spec.rotY,
    });
  }

  const _activeResult: {
    targetId: string;
    kind: GroundTargetKind;
    outcome: GroundTargetOutcome;
    aimWorldPos: THREE.Vector3;
    isFiring: boolean;
  } = {
    targetId: '',
    kind: 'tank',
    outcome: 'explode',
    aimWorldPos: new THREE.Vector3(),
    isFiring: false,
  };

  const update = (
    timeSec: number,
    dt: number,
    role: GroundTargetSpec['role'] | null,
    callbacks?: GroundTargetCombatCallbacks,
  ): ActiveGroundEngagement | null => {
    const safeDt = Math.min(0.05, Math.max(0.001, dt));
    let lockedSlot: InternalTargetSlot | null = null;

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const isRoleMatch = role !== null && s.spec.role === role;
      const inEngageWindow =
        isRoleMatch && timeSec >= s.spec.engageStartSec && timeSec <= s.spec.engageEndSec;

      // Advance moving enemy vehicles slowly along valley until disabled/destroyed
      if (s.state === 'active' && s.spec.moveSpeedMps > 0 && isRoleMatch) {
        const travelT = Math.max(0, Math.min(s.spec.resolveTimeSec, timeSec) - Math.max(0, s.spec.engageStartSec - 2.5));
        const dist = Math.min(11.0, travelT * s.spec.moveSpeedMps);
        s.worldPos.set(
          s.spec.startPos[0] + s.forwardDir.x * dist,
          s.spec.startPos[1],
          s.spec.startPos[2] + s.forwardDir.z * dist,
        );
        for (let w = 0; w < s.wheels.length; w++) {
          s.wheels[w].rotation.x -= safeDt * s.spec.moveSpeedMps * 2.2;
        }
      }

      const aimHeight = s.spec.kind === 'tank' ? 1.55 : s.spec.kind === 'apc' ? 1.65 : 1.25;
      s.aimPos.set(s.worldPos.x, s.worldPos.y + aimHeight, s.worldPos.z);

      // Select highest-priority active engagement slot for door-gunner world-space tracking
      if (inEngageWindow) {
        if (!lockedSlot || (lockedSlot.state !== 'active' && s.state === 'active')) {
          lockedSlot = s;
        }
      }

      // Apply live bullet impacts & sparks during active engagement before resolution
      if (inEngageWindow && s.state === 'active') {
        s.damageShake = 1.0;
        const sparkBucket = Math.floor(timeSec * 6.5);
        if (sparkBucket !== s.lastSparkBucket) {
          s.lastSparkBucket = sparkBucket;
          callbacks?.onHitSparks?.(s.aimPos, s.spec.kind === 'infantry' ? 2 : 5);
        }

        // Resolve outcome when threshold time is reached!
        if (timeSec >= s.spec.resolveTimeSec) {
          if (s.spec.outcome === 'explode') {
            s.state = 'exploded';
            for (let m = 0; m < s.armorMats.length; m++) {
              s.armorMats[m].color.setHex(0x161719);
              s.armorMats[m].roughness = 0.95;
            }
            for (let e = 0; e < s.emissiveMeshes.length; e++) {
              s.emissiveMeshes[e].visible = false;
            }
            if (s.turretPivot) {
              s.turretPivot.position.y += 0.14;
              s.turretPivot.rotation.set(0.24, 0.65, -0.32);
            }
            if (s.fireMesh) {
              s.fireMesh.visible = true;
            }
            callbacks?.onExplode?.(s.worldPos, s.spec.kind);
          } else {
            s.state = 'neutralized';
            for (let m = 0; m < s.armorMats.length; m++) {
              s.armorMats[m].color.multiplyScalar(0.68);
            }
            for (let e = 0; e < s.emissiveMeshes.length; e++) {
              s.emissiveMeshes[e].visible = false;
            }
            if (s.spec.kind !== 'infantry') {
              callbacks?.onDisableSmoke?.(s.worldPos);
            }
            callbacks?.onNeutralize?.(s.worldPos, s.spec.kind);
          }
        }
      } else {
        s.damageShake = THREE.MathUtils.damp(s.damageShake, 0, 10.0, safeDt);
      }

      // Apply hull jitter, disabled list, turret sweep, and post-hit smoke/fire animations
      const jitterX = s.damageShake > 0.05 ? Math.sin(timeSec * 64 + i) * 0.055 * s.damageShake : 0;
      const jitterZ = s.damageShake > 0.05 ? Math.cos(timeSec * 58 + i) * 0.055 * s.damageShake : 0;
      s.root.position.set(s.worldPos.x + jitterX, s.worldPos.y, s.worldPos.z + jitterZ);

      if (s.spec.kind !== 'infantry') {
        if (s.state === 'neutralized') {
          s.root.rotation.set(0.04, s.baseYaw, -0.09);
          // Emit periodic dark engine-kill smoke puffs (no fireball!)
          const smokeBucket = Math.floor(timeSec * 0.9 + i * 0.37);
          if (smokeBucket !== s.lastSmokeBucket) {
            s.lastSmokeBucket = smokeBucket;
            callbacks?.onDisableSmoke?.(s.worldPos);
          }
        } else if (s.state === 'exploded') {
          s.root.rotation.set(-0.06, s.baseYaw + 0.08, 0.11);
          if (s.fireMesh) {
            const fl = 0.85 + Math.sin(timeSec * 15 + i * 2) * 0.32;
            s.fireMesh.scale.set(1.05 * fl, 1.45 * fl, 1.05 * fl);
            s.fireMesh.rotation.y = timeSec * 2.1 + i;
          }
          const smokeBucket = Math.floor(timeSec * 1.1 + i * 0.5);
          if (smokeBucket !== s.lastSmokeBucket) {
            s.lastSmokeBucket = smokeBucket;
            callbacks?.onDisableSmoke?.(s.worldPos);
          }
        } else {
          s.root.rotation.set(0, s.baseYaw, 0);
          if (s.turretPivot) {
            s.turretPivot.rotation.y = Math.sin(timeSec * 0.65 + i * 1.7) * 0.42;
          }
        }
      } else if (s.infantry) {
        if (s.state === 'neutralized') {
          s.downBlend = THREE.MathUtils.damp(s.downBlend, 1, 7.2, safeDt);
          s.infantry.muzzleFlashMesh.visible = false;
        } else {
          s.downBlend = 0;
          const returnFire = isRoleMatch && Math.sin(timeSec * 11 + i * 2.1) > 0.72;
          s.infantry.muzzleFlashMesh.visible = returnFire;
          s.infantry.muzzleFlashMesh.rotation.z = timeSec * 44;
        }
        s.infantry.skeleton.root.position.set(0, -s.downBlend * 0.1, 0);
        poseHostileCombatant(s.infantry.skeleton, timeSec + i, s.downBlend, s.infantry.weaponMount);
      }
    }

    if (!lockedSlot) return null;
    _activeResult.targetId = lockedSlot.spec.id;
    _activeResult.kind = lockedSlot.spec.kind;
    _activeResult.outcome = lockedSlot.spec.outcome;
    _activeResult.aimWorldPos.copy(lockedSlot.aimPos);
    _activeResult.isFiring = true;
    return _activeResult;
  };

  const getTargetSummaries = (): GroundTargetSummary[] =>
    slots.map((s) => ({
      id: s.spec.id,
      kind: s.spec.kind,
      outcome: s.spec.outcome,
      state: s.state,
    }));

  return {
    root,
    update,
    getTargetSummaries,
    dispose: () => {
      for (const s of slots) {
        s.infantry?.dispose();
      }
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

import * as THREE from 'three';
import { SolidObb, raycastAgainstObbs, ObbRaycastHit } from './OpenWorldCivilizationTopology';
import {
  FobCompoundId,
  FobRangeTargetSpec,
  getFobCheckpointGateSpec,
  getFobRangeTargetSpecs,
} from './OpenWorldFobLayout';

export interface FobGateRuntimeState {
  readonly fobId: FobCompoundId;
  readonly faction: 'pmc_alpha' | 'pmc_bravo';
  readonly gateCenterX: number;
  readonly gateCenterZ: number;
  readonly pivotGroup: THREE.Group;
  readonly yaw: number;
  readonly armLengthM: number;
  openFactor: number; // 0 = closed horizontal, 1 = open raised 76 deg
  targetOpenFactor: number;
  closedObb: SolidObb;
}

export interface RangeTargetRuntimeState {
  readonly spec: FobRangeTargetSpec;
  readonly pivotGroup: THREE.Group;
  readonly hitMesh: THREE.Mesh;
  readonly faceMat: THREE.MeshStandardMaterial;
  knockdownTimerSec: number;
  tiltAngleRad: number;
  hitCount: number;
}

export interface RangeTargetHitOutcome {
  hit: boolean;
  targetId: string;
  fobId: FobCompoundId;
  area: 'gun_range' | 'cqb_house';
  laneLabel: string;
  distanceM: number;
  hitCount: number;
}

// Module-scope zero-GC scratch arrays
const _raycaster = new THREE.Raycaster();
const _hits: THREE.Intersection[] = [];
const _obbScratch: SolidObb[] = [];
const _tmpNormal = new THREE.Vector3();

/**
 * Manages live animated Military Checkpoint Boom Gates and reactive Barrack Gun-Range / CQB Shoot-House targets
 * for both Alpha FOB and Bravo FOB.
 */
export class OpenWorldFobDynamicProps {
  private readonly rootGroup = new THREE.Group();
  private readonly gates: FobGateRuntimeState[] = [];
  private readonly targets = new Map<string, RangeTargetRuntimeState>();
  public readonly hitMeshes: THREE.Object3D[] = [];

  private readonly sharedGeos: THREE.BufferGeometry[] = [];
  private readonly sharedMats: THREE.Material[] = [];

  constructor(scene: THREE.Scene) {
    this.rootGroup.name = 'openworld_fob_dynamic_props';
    scene.add(this.rootGroup);
    this.buildGates();
    this.buildRangeTargets();
  }

  private buildGates(): void {
    const redMat = new THREE.MeshStandardMaterial({
      color: 0xc92a2a,
      roughness: 0.48,
      metalness: 0.25,
    });
    const whiteMat = new THREE.MeshStandardMaterial({
      color: 0xe9ecef,
      roughness: 0.45,
      metalness: 0.18,
    });
    const steelMat = new THREE.MeshStandardMaterial({
      color: 0x3b4248,
      roughness: 0.5,
      metalness: 0.72,
    });
    const weightMat = new THREE.MeshStandardMaterial({
      color: 0x22262a,
      roughness: 0.7,
      metalness: 0.65,
    });
    const tipBeaconMat = new THREE.MeshStandardMaterial({
      color: 0xffaa2b,
      emissive: 0xff6b00,
      emissiveIntensity: 0.9,
      roughness: 0.3,
    });
    this.sharedMats.push(redMat, whiteMat, steelMat, weightMat, tipBeaconMat);

    const hubGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.34, 10);
    hubGeo.rotateX(Math.PI * 0.5);
    const weightGeo = new THREE.BoxGeometry(0.75, 0.28, 0.26);
    const segGeo = new THREE.BoxGeometry(0.82, 0.13, 0.11);
    const tipGeo = new THREE.BoxGeometry(0.24, 0.16, 0.16);
    this.sharedGeos.push(hubGeo, weightGeo, segGeo, tipGeo);

    for (const fobId of ['landmark_fob_alpha', 'landmark_fob_bravo'] as const) {
      const spec = getFobCheckpointGateSpec(fobId);
      const pivotGroup = new THREE.Group();
      pivotGroup.name = `fob_boom_gate_${fobId}`;
      pivotGroup.position.set(spec.pivotX, spec.pivotY, spec.pivotZ);
      pivotGroup.rotation.y = spec.yaw;

      const armHolder = new THREE.Group();
      pivotGroup.add(armHolder);

      const hub = new THREE.Mesh(hubGeo, steelMat);
      armHolder.add(hub);

      const counterweight = new THREE.Mesh(weightGeo, weightMat);
      counterweight.position.set(0.55, 0, 0);
      armHolder.add(counterweight);

      // Alternating red & white boom segments extending from +3.85m pedestal across -X to -3.55m
      const segCount = Math.floor(spec.armLengthM / 0.82);
      for (let i = 0; i < segCount; i++) {
        const seg = new THREE.Mesh(segGeo, i % 2 === 0 ? redMat : whiteMat);
        seg.position.set(-(i + 0.5) * 0.82, 0, 0);
        armHolder.add(seg);
      }

      const tip = new THREE.Mesh(tipGeo, tipBeaconMat);
      tip.position.set(-spec.armLengthM + 0.12, 0.08, 0);
      armHolder.add(tip);

      this.rootGroup.add(pivotGroup);

      // Build SolidObb centered along boom arm when closed
      const armWorldHalf = spec.armLengthM * 0.5;
      const cosY = Math.cos(spec.yaw);
      const sinY = Math.sin(spec.yaw);
      const midLx = -armWorldHalf;
      const midX = spec.pivotX + midLx * cosY;
      const midZ = spec.pivotZ - midLx * sinY;

      this.gates.push({
        fobId,
        faction: spec.faction,
        gateCenterX: spec.gateCenterX,
        gateCenterZ: spec.gateCenterZ,
        pivotGroup: armHolder,
        yaw: spec.yaw,
        armLengthM: spec.armLengthM,
        openFactor: 0,
        targetOpenFactor: 0,
        closedObb: {
          cx: midX,
          cy: spec.pivotY,
          cz: midZ,
          hx: armWorldHalf,
          hy: 0.25,
          hz: 0.22,
          cosY,
          sinY,
          surface: 'metal',
          blocksBullets: true,
          blocksPlayer: true,
        },
      });
    }
  }

  private buildRangeTargets(): void {
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x2c3238,
      roughness: 0.65,
      metalness: 0.65,
    });
    const postMat = new THREE.MeshStandardMaterial({
      color: 0x4b535c,
      roughness: 0.55,
      metalness: 0.6,
    });
    this.sharedMats.push(baseMat, postMat);

    const baseGeo = new THREE.BoxGeometry(0.68, 0.12, 0.52);
    const postGeo = new THREE.BoxGeometry(0.08, 0.72, 0.08);
    const torsoGeo = new THREE.BoxGeometry(0.54, 0.78, 0.06);
    const headGeo = new THREE.BoxGeometry(0.24, 0.26, 0.07);
    this.sharedGeos.push(baseGeo, postGeo, torsoGeo, headGeo);

    for (const fobId of ['landmark_fob_alpha', 'landmark_fob_bravo'] as const) {
      const specs = getFobRangeTargetSpecs(fobId);
      for (const spec of specs) {
        const container = new THREE.Group();
        container.name = `range_target_${spec.id}`;
        container.position.set(spec.worldX, spec.worldY, spec.worldZ);
        container.rotation.y = spec.yaw;

        const basePlate = new THREE.Mesh(baseGeo, baseMat);
        basePlate.position.y = 0.06;
        container.add(basePlate);

        const pivotGroup = new THREE.Group();
        pivotGroup.position.set(0, 0.12, 0);
        container.add(pivotGroup);

        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(0, 0.36, 0);
        pivotGroup.add(post);

        const faceMat = new THREE.MeshStandardMaterial({
          color: spec.area === 'gun_range' ? 0xd96b27 : 0x3b82f6,
          emissive: 0x111111,
          roughness: 0.42,
          metalness: 0.32,
        });
        this.sharedMats.push(faceMat);

        const torso = new THREE.Mesh(torsoGeo, faceMat);
        torso.position.set(0, 1.06, 0);
        torso.userData.openWorldRangeTargetId = spec.id;
        torso.userData.ballisticMaterial = 'metal';
        pivotGroup.add(torso);

        const head = new THREE.Mesh(headGeo, faceMat);
        head.position.set(0, 1.58, 0);
        head.userData.openWorldRangeTargetId = spec.id;
        head.userData.ballisticMaterial = 'metal';
        pivotGroup.add(head);

        this.rootGroup.add(container);
        this.hitMeshes.push(torso, head);
        this.targets.set(spec.id, {
          spec,
          pivotGroup,
          hitMesh: torso,
          faceMat,
          knockdownTimerSec: 0,
          tiltAngleRad: 0,
          hitCount: 0,
        });
      }
    }
  }

  public setGateTargetOpen(fobId: FobCompoundId, open: boolean): void {
    for (let i = 0; i < this.gates.length; i++) {
      if (this.gates[i].fobId === fobId) {
        this.gates[i].targetOpenFactor = open ? 1 : 0;
      }
    }
  }

  public getGateState(fobId: FobCompoundId): FobGateRuntimeState | undefined {
    return this.gates.find((g) => g.fobId === fobId);
  }

  public triggerTargetHit(
    targetId: string,
    shooterX: number,
    shooterZ: number,
  ): RangeTargetHitOutcome | null {
    const rec = this.targets.get(targetId);
    if (!rec) return null;
    rec.knockdownTimerSec = 2.8;
    rec.hitCount += 1;
    rec.faceMat.emissive.setHex(0x6b2f0b);
    const distM = Math.round(Math.hypot(rec.spec.worldX - shooterX, rec.spec.worldZ - shooterZ));
    return {
      hit: true,
      targetId: rec.spec.id,
      fobId: rec.spec.fobId,
      area: rec.spec.area,
      laneLabel: rec.spec.laneLabel,
      distanceM: distM,
      hitCount: rec.hitCount,
    };
  }

  /**
   * Resolves dynamic closed boom gate barrier collisions against player capsule.
   * Players can duck/walk under once openFactor >= 0.45, or must wait for checkpoint guards to raise it.
   */
  public resolveClosedGateObbs(outObbs: SolidObb[]): void {
    outObbs.length = 0;
    for (let i = 0; i < this.gates.length; i++) {
      const g = this.gates[i];
      if (g.openFactor < 0.45) {
        outObbs.push(g.closedObb);
      }
    }
  }

  /**
   * Raycast against closed checkpoint boom gates (so bullets strike lowered steel arms).
   */
  public raycastClosedGates(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    near: number,
    outHit: ObbRaycastHit,
  ): boolean {
    this.resolveClosedGateObbs(_obbScratch);
    if (_obbScratch.length === 0) return false;
    return raycastAgainstObbs(_obbScratch, ox, oy, oz, dx, dy, dz, near, outHit);
  }

  /**
   * Raycast reactive range & CQB targets for BallisticsSolver.
   */
  public raycastTargets(
    origin: Readonly<THREE.Vector3>,
    direction: Readonly<THREE.Vector3>,
    near: number,
    far: number,
    outPoint: THREE.Vector3,
    outNormal: THREE.Vector3,
  ): { hit: boolean; distance: number; object: THREE.Object3D | null } {
    if (this.hitMeshes.length === 0) {
      return { hit: false, distance: far, object: null };
    }
    _raycaster.set(origin as THREE.Vector3, direction as THREE.Vector3);
    _raycaster.near = near;
    _raycaster.far = far;
    _hits.length = 0;
    _raycaster.intersectObjects(this.hitMeshes, false, _hits);

    for (let i = 0; i < _hits.length; i++) {
      const h = _hits[i];
      if (!h.object.visible) continue;
      outPoint.copy(h.point);
      if (h.face) {
        _tmpNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
        outNormal.copy(_tmpNormal);
      } else {
        outNormal.set(-direction.x, -direction.y, -direction.z);
      }
      return { hit: true, distance: h.distance, object: h.object };
    }
    return { hit: false, distance: far, object: null };
  }

  public update(dt: number): void {
    // 1. Animate motorized boom gates smoothly between closed (0) and raised 76° (1)
    for (let i = 0; i < this.gates.length; i++) {
      const g = this.gates[i];
      const rate = g.targetOpenFactor > g.openFactor ? 1.85 : 1.4;
      if (Math.abs(g.targetOpenFactor - g.openFactor) > 0.001) {
        if (g.openFactor < g.targetOpenFactor) {
          g.openFactor = Math.min(g.targetOpenFactor, g.openFactor + rate * dt);
        } else {
          g.openFactor = Math.max(g.targetOpenFactor, g.openFactor - rate * dt);
        }
      }
      // Rotate around +Z (tilts arm from horizontal -X upward into +Y)
      // Since arm extends along -X, negative rotation around Z lifts the -X tip up!
      g.pivotGroup.rotation.z = -g.openFactor * 1.32;
    }

    // 2. Animate reactive knockdown targets
    for (const rec of this.targets.values()) {
      let targetTilt = 0;
      if (rec.knockdownTimerSec > 0) {
        rec.knockdownTimerSec = Math.max(0, rec.knockdownTimerSec - dt);
        targetTilt = -Math.PI * 0.44;
        if (rec.knockdownTimerSec <= 0) {
          rec.faceMat.emissive.setHex(0x111111);
        }
      }
      const speed = targetTilt < rec.tiltAngleRad ? 16 : 6.5;
      rec.tiltAngleRad += (targetTilt - rec.tiltAngleRad) * Math.min(1, dt * speed);
      rec.pivotGroup.rotation.x = rec.tiltAngleRad;
    }
  }

  public dispose(): void {
    this.rootGroup.parent?.remove(this.rootGroup);
    for (const g of this.sharedGeos) g.dispose();
    for (const m of this.sharedMats) m.dispose();
    this.sharedGeos.length = 0;
    this.sharedMats.length = 0;
    this.gates.length = 0;
    this.targets.clear();
    this.hitMeshes.length = 0;
  }
}

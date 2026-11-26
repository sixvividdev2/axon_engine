import * as THREE from 'three';
import { IBodycamWorldAdapter, createRaycastResult, BodycamRaycastResult } from '../types';
import { IBodycamAudioSource } from '../IBodycamAudioSource';

export type LiveRoundVisualKind = 'rifle' | 'pistol' | 'shotgun';

export interface EjectedLiveRoundSpawnOptions {
  position: Readonly<THREE.Vector3>;
  quaternion: Readonly<THREE.Quaternion>;
  caliberId: string;
  caliberLabel: string;
  weaponId: string;
  kind?: LiveRoundVisualKind;
  holdClass?: string;
  /** Optional inherited player velocity (m/s) */
  carrierVelocity?: Readonly<THREE.Vector3>;
}

export interface EjectedLiveRoundPickupCandidate {
  id: number;
  caliberId: string;
  caliberLabel: string;
  weaponId: string;
  kind: LiveRoundVisualKind;
  distanceM: number;
  worldPos: THREE.Vector3;
}

export interface CollectedLiveRound {
  id: number;
  caliberId: string;
  caliberLabel: string;
  weaponId: string;
  kind: LiveRoundVisualKind;
}

interface PooledLiveRound {
  id: number;
  active: boolean;
  settled: boolean;
  age: number;
  bounceCount: number;
  kind: LiveRoundVisualKind;
  caliberId: string;
  caliberLabel: string;
  weaponId: string;
  radiusM: number;
  root: THREE.Group;
  rifleGroup: THREE.Group;
  pistolGroup: THREE.Group;
  shotgunGroup: THREE.Group;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
}

const POOL_SIZE = 24;
const MAX_ROUND_LIFETIME_SEC = 180;
const GRAVITY_MPS2 = 9.81;

/** Resolves the 3D live ammunition mesh style from caliber ID and weapon hold class. */
export function resolveLiveRoundKind(
  caliberId: string | undefined,
  holdClass?: string,
): LiveRoundVisualKind {
  const cal = (caliberId ?? '').toLowerCase();
  if (
    holdClass === 'shotgun' ||
    cal.includes('12g') ||
    cal.includes('20g') ||
    cal.includes('buck') ||
    cal.includes('slug') ||
    cal.includes('shot')
  ) {
    return 'shotgun';
  }
  if (
    holdClass === 'pistol' ||
    cal.includes('9x19') ||
    cal.includes('9x18') ||
    cal.includes('45acp') ||
    cal.includes('357') ||
    cal.includes('38') ||
    cal.includes('44') ||
    cal.includes('50ae') ||
    cal.includes('57x28') ||
    cal.includes('46x30')
  ) {
    return 'pistol';
  }
  return 'rifle';
}

/**
 * Zero-GC pooled world system for manually ejected intact live ammunition cartridges & shotgun shells.
 *
 * Unlike fired spent brass (high blowback velocity, non-interactive), manually cycled live rounds:
 *  - Use multi-part composite PBR models (brass case + rim + copper-jacketed projectile or ribbed shotgun hull + high-brass head)
 *  - Eject with slightly less force (~55–65% of fired casing velocity) for a realistic manual-extraction arc
 *  - Bounce & settle cleanly flat on world floors/surfaces via raycast or ground-height probe
 *  - Can be inspected and picked back up with Interact (`F`) to restore +1 round to reserve/inventory
 */
export class EjectedLiveRoundPool {
  public readonly group = new THREE.Group();
  private readonly pool: PooledLiveRound[] = [];
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private nextRoundId = 1;
  private cursor = 0;

  // Shared materials & geometries (allocated once, cleanly disposed)
  private readonly brassMat: THREE.MeshStandardMaterial;
  private readonly copperJacketMat: THREE.MeshStandardMaterial;
  private readonly primerMat: THREE.MeshStandardMaterial;
  private readonly hullMat: THREE.MeshStandardMaterial;
  private readonly hullCrimpMat: THREE.MeshStandardMaterial;

  // Scratch math objects (zero per-frame heap allocations)
  private readonly _rayOrigin = new THREE.Vector3();
  private readonly _rayDown = new THREE.Vector3(0, -1, 0);
  private readonly _rayHit: BodycamRaycastResult = createRaycastResult();
  private readonly _localVel = new THREE.Vector3();
  private readonly _toRound = new THREE.Vector3();
  private readonly _candidatePos = new THREE.Vector3();
  private readonly _candidateOut: EjectedLiveRoundPickupCandidate = {
    id: 0,
    caliberId: '',
    caliberLabel: '',
    weaponId: '',
    kind: 'rifle',
    distanceM: Infinity,
    worldPos: this._candidatePos,
  };

  constructor(scene: THREE.Scene) {
    this.group.name = 'ejected_live_rounds_pool';
    scene.add(this.group);

    this.brassMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xd9b352,
        metalness: 0.90,
        roughness: 0.24,
      }),
    );
    this.copperJacketMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xc87442,
        metalness: 0.86,
        roughness: 0.28,
      }),
    );
    this.primerMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xbec4cc,
        metalness: 0.88,
        roughness: 0.30,
      }),
    );
    this.hullMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x9e2124,
        metalness: 0.08,
        roughness: 0.56,
      }),
    );
    this.hullCrimpMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x7c171a,
        metalness: 0.05,
        roughness: 0.68,
      }),
    );

    // Shared composite geometries (scaled for clear ground visibility in bodycam 1P while staying authentic)
    // Rifle cartridge (~5.6cm length, oriented along local Y so laying flat = rotation.z = PI/2)
    const geoRifleRim = this.track(new THREE.CylinderGeometry(0.0062, 0.0062, 0.0022, 8));
    const geoRifleBody = this.track(new THREE.CylinderGeometry(0.0054, 0.0058, 0.030, 8));
    const geoRifleShoulder = this.track(new THREE.CylinderGeometry(0.0038, 0.0054, 0.0065, 8));
    const geoRifleNeck = this.track(new THREE.CylinderGeometry(0.0037, 0.0038, 0.005, 8));
    const geoRifleBullet = this.track(new THREE.ConeGeometry(0.0035, 0.017, 8));
    const geoPrimer = this.track(new THREE.CylinderGeometry(0.0028, 0.0028, 0.001, 6));

    // Pistol cartridge (~3.1cm length, straight-wall brass + rounded FMJ ogive)
    const geoPistolRim = this.track(new THREE.CylinderGeometry(0.0064, 0.0064, 0.002, 8));
    const geoPistolBody = this.track(new THREE.CylinderGeometry(0.0058, 0.0059, 0.019, 8));
    const geoPistolBulletCyl = this.track(new THREE.CylinderGeometry(0.0052, 0.0054, 0.006, 8));
    const geoPistolBulletTip = this.track(new THREE.SphereGeometry(0.0052, 8, 6));

    // 12ga Shotgun shell (~6.4cm length, ribbed crimson polymer hull + high-brass head + rim)
    const geoShotRim = this.track(new THREE.CylinderGeometry(0.0124, 0.0124, 0.0028, 10));
    const geoShotBrass = this.track(new THREE.CylinderGeometry(0.0110, 0.0112, 0.018, 10));
    const geoShotHull = this.track(new THREE.CylinderGeometry(0.0108, 0.0109, 0.044, 10));
    const geoShotCrimp = this.track(new THREE.CylinderGeometry(0.0094, 0.0106, 0.004, 10));

    for (let i = 0; i < POOL_SIZE; i++) {
      const root = new THREE.Group();
      root.visible = false;

      // 1. Rifle composite group
      const rifleGroup = new THREE.Group();
      const rRim = new THREE.Mesh(geoRifleRim, this.brassMat);
      rRim.position.y = -0.025;
      const rPrimer = new THREE.Mesh(geoPrimer, this.primerMat);
      rPrimer.position.y = -0.0262;
      const rBody = new THREE.Mesh(geoRifleBody, this.brassMat);
      rBody.position.y = -0.009;
      const rShoulder = new THREE.Mesh(geoRifleShoulder, this.brassMat);
      rShoulder.position.y = 0.009;
      const rNeck = new THREE.Mesh(geoRifleNeck, this.brassMat);
      rNeck.position.y = 0.0145;
      const rBullet = new THREE.Mesh(geoRifleBullet, this.copperJacketMat);
      rBullet.position.y = 0.025;
      rifleGroup.add(rRim, rPrimer, rBody, rShoulder, rNeck, rBullet);

      // 2. Pistol composite group
      const pistolGroup = new THREE.Group();
      const pRim = new THREE.Mesh(geoPistolRim, this.brassMat);
      pRim.position.y = -0.014;
      const pPrimer = new THREE.Mesh(geoPrimer, this.primerMat);
      pPrimer.position.y = -0.0151;
      const pBody = new THREE.Mesh(geoPistolBody, this.brassMat);
      pBody.position.y = -0.0035;
      const pBulletCyl = new THREE.Mesh(geoPistolBulletCyl, this.copperJacketMat);
      pBulletCyl.position.y = 0.0085;
      const pBulletTip = new THREE.Mesh(geoPistolBulletTip, this.copperJacketMat);
      pBulletTip.scale.set(1, 1.15, 1);
      pBulletTip.position.y = 0.0115;
      pistolGroup.add(pRim, pPrimer, pBody, pBulletCyl, pBulletTip);
      pistolGroup.visible = false;

      // 3. Shotgun composite group
      const shotgunGroup = new THREE.Group();
      const sRim = new THREE.Mesh(geoShotRim, this.brassMat);
      sRim.position.y = -0.031;
      const sPrimer = new THREE.Mesh(geoPrimer, this.primerMat);
      sPrimer.scale.setScalar(1.35);
      sPrimer.position.y = -0.0325;
      const sBrass = new THREE.Mesh(geoShotBrass, this.brassMat);
      sBrass.position.y = -0.021;
      const sHull = new THREE.Mesh(geoShotHull, this.hullMat);
      sHull.position.y = 0.0095;
      const sCrimp = new THREE.Mesh(geoShotCrimp, this.hullCrimpMat);
      sCrimp.position.y = 0.0325;
      shotgunGroup.add(sRim, sPrimer, sBrass, sHull, sCrimp);
      shotgunGroup.visible = false;

      root.add(rifleGroup, pistolGroup, shotgunGroup);
      this.group.add(root);

      this.pool.push({
        id: 0,
        active: false,
        settled: false,
        age: 0,
        bounceCount: 0,
        kind: 'rifle',
        caliberId: '556x45',
        caliberLabel: '5.56x45mm',
        weaponId: 'm4a1',
        radiusM: 0.007,
        root,
        rifleGroup,
        pistolGroup,
        shotgunGroup,
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
      });
    }
  }

  private track<T extends { dispose: () => void }>(res: T): T {
    this.disposables.push(res);
    return res;
  }

  /**
   * Ejects an intact live round from the weapon's ejection port with gentler manual-extraction velocity
   * (~55–65% of fired casing force) so it arcs realistically out and lands nearby for pickup.
   */
  public spawnRound(opts: EjectedLiveRoundSpawnOptions): number {
    // Prefer an inactive slot; otherwise reuse round-robin
    let slot: PooledLiveRound | null = null;
    for (let i = 0; i < this.pool.length; i++) {
      const idx = (this.cursor + i) % this.pool.length;
      if (!this.pool[idx].active) {
        slot = this.pool[idx];
        this.cursor = (idx + 1) % this.pool.length;
        break;
      }
    }
    if (!slot) {
      slot = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % this.pool.length;
    }

    const kind = opts.kind ?? resolveLiveRoundKind(opts.caliberId, opts.holdClass);
    slot.id = this.nextRoundId++;
    slot.active = true;
    slot.settled = false;
    slot.age = 0;
    slot.bounceCount = 0;
    slot.kind = kind;
    slot.caliberId = opts.caliberId;
    slot.caliberLabel = opts.caliberLabel;
    slot.weaponId = opts.weaponId;
    slot.radiusM = kind === 'shotgun' ? 0.012 : kind === 'pistol' ? 0.0065 : 0.007;

    slot.rifleGroup.visible = kind === 'rifle';
    slot.pistolGroup.visible = kind === 'pistol';
    slot.shotgunGroup.visible = kind === 'shotgun';

    slot.root.position.copy(opts.position);
    slot.root.quaternion.copy(opts.quaternion);
    slot.root.rotateZ(Math.PI * 0.42);
    slot.root.visible = true;

    // Gentle manual-extraction velocity (~55–65% of fired casing force):
    // Fired casings use lateral 1.55..2.40, up 1.25..1.90, back 0.35..0.80.
    // Manual bolt/slide extraction imparts a noticeably softer arc that lands within reach.
    this._localVel.set(
      0.86 + Math.random() * 0.38,
      0.58 + Math.random() * 0.32,
      0.14 + Math.random() * 0.20,
    );
    slot.vel.copy(this._localVel).applyQuaternion(opts.quaternion);
    if (opts.carrierVelocity) {
      slot.vel.addScaledVector(opts.carrierVelocity, 0.45);
    }

    // Slower, weighty manual tumble compared to high-pressure fired brass spin
    slot.angVel.set(
      (Math.random() - 0.5) * 14,
      7 + Math.random() * 8,
      (Math.random() - 0.5) * 14,
    );

    return slot.id;
  }

  /**
   * Advances physics, ground bounces, and flat settling for all active ejected live rounds.
   * Accepts either an `IBodycamWorldAdapter` (raycast against floors/tables/stairs) or a ground-height callback.
   */
  public update(
    dtRaw: number,
    worldAdapter?: IBodycamWorldAdapter | null,
    getGroundY?: ((x: number, z: number) => number) | null,
    audio?: IBodycamAudioSource | null,
  ): void {
    const dt = Math.min(Math.max(dtRaw, 0.001), 0.05);

    for (let i = 0; i < this.pool.length; i++) {
      const r = this.pool[i];
      if (!r.active) continue;

      r.age += dt;
      if (r.age >= MAX_ROUND_LIFETIME_SEC) {
        r.active = false;
        r.root.visible = false;
        continue;
      }

      if (r.settled) continue;

      const prevY = r.root.position.y;
      r.vel.y -= GRAVITY_MPS2 * dt;
      r.root.position.addScaledVector(r.vel, dt);
      r.root.rotation.x += r.angVel.x * dt;
      r.root.rotation.y += r.angVel.y * dt;
      r.root.rotation.z += r.angVel.z * dt;

      // Resolve floor/surface height directly below the round
      let surfaceY = 0;
      let foundSurface = false;
      if (worldAdapter) {
        this._rayOrigin.set(r.root.position.x, Math.max(prevY, r.root.position.y) + 0.14, r.root.position.z);
        if (worldAdapter.raycast(this._rayOrigin, this._rayDown, 0.01, 4.5, this._rayHit)) {
          surfaceY = this._rayHit.pointY;
          foundSurface = true;
        }
      }
      if (!foundSurface && getGroundY) {
        const gy = getGroundY(r.root.position.x, r.root.position.z);
        if (Number.isFinite(gy)) {
          surfaceY = gy;
          foundSurface = true;
        }
      }
      if (!foundSurface) {
        surfaceY = 0;
      }

      const restY = surfaceY + r.radiusM;
      if (r.root.position.y <= restY && r.vel.y <= 0) {
        r.root.position.y = restY;
        const impactSpeed = Math.abs(r.vel.y);
        r.bounceCount += 1;

        if (r.bounceCount === 1 && impactSpeed > 0.45 && audio?.playWeaponCue) {
          audio.playWeaponCue('mode_toggle', {
            intensity: Math.min(0.45, impactSpeed * 0.12),
            position: r.root.position,
            weightClass: 'pistol',
          });
        }

        if (impactSpeed < 0.48 || r.bounceCount >= 3) {
          // Settle cleanly flat on its side on the ground
          r.vel.set(0, 0, 0);
          r.angVel.set(0, 0, 0);
          r.settled = true;
          const yaw = r.root.rotation.y;
          r.root.rotation.set(Math.PI * 0.5, yaw, 0);
        } else {
          r.vel.y = impactSpeed * 0.34;
          r.vel.x *= 0.58;
          r.vel.z *= 0.58;
          r.angVel.multiplyScalar(0.52);
        }
      }
    }
  }

  /**
   * Finds the best nearby ejected live round under the player's crosshair (or directly beneath them)
   * for contextual Interact (`F`) pickup. Returns a zero-GC reused candidate reference or null.
   */
  public findLookedAtPickup(
    camPos: Readonly<THREE.Vector3>,
    camDir: Readonly<THREE.Vector3>,
    maxDistM = 2.65,
  ): Readonly<EjectedLiveRoundPickupCandidate> | null {
    let best: PooledLiveRound | null = null;
    let bestScore = Infinity;
    let bestDist = Infinity;

    for (let i = 0; i < this.pool.length; i++) {
      const r = this.pool[i];
      if (!r.active) continue;
      // Allow picking up settled rounds or nearly-settled rounds (age > 0.25s)
      if (!r.settled && r.age < 0.25) continue;

      this._toRound.subVectors(r.root.position, camPos);
      const dist = this._toRound.length();
      if (dist > maxDistM || dist < 0.05) continue;

      const invDist = 1 / dist;
      const dot =
        (this._toRound.x * camDir.x + this._toRound.y * camDir.y + this._toRound.z * camDir.z) *
        invDist;

      // Generous pickup cone since individual cartridges on the ground are small
      const minDot = dist < 1.35 ? 0.74 : 0.86;
      if (dot < minDot) continue;

      const score = dist * (1.25 - dot);
      if (score < bestScore) {
        bestScore = score;
        bestDist = dist;
        best = r;
      }
    }

    if (!best) return null;

    this._candidateOut.id = best.id;
    this._candidateOut.caliberId = best.caliberId;
    this._candidateOut.caliberLabel = best.caliberLabel;
    this._candidateOut.weaponId = best.weaponId;
    this._candidateOut.kind = best.kind;
    this._candidateOut.distanceM = bestDist;
    this._candidateOut.worldPos.copy(best.root.position);
    return this._candidateOut;
  }

  /** Collects an ejected live round by ID, hiding it and returning its metadata. */
  public collectRound(id: number): CollectedLiveRound | null {
    for (let i = 0; i < this.pool.length; i++) {
      const r = this.pool[i];
      if (!r.active || r.id !== id) continue;
      r.active = false;
      r.settled = false;
      r.root.visible = false;
      return {
        id: r.id,
        caliberId: r.caliberId,
        caliberLabel: r.caliberLabel,
        weaponId: r.weaponId,
        kind: r.kind,
      };
    }
    return null;
  }

  public getActiveCount(): number {
    let count = 0;
    for (let i = 0; i < this.pool.length; i++) {
      if (this.pool[i].active) count++;
    }
    return count;
  }

  /** Useful for tests/inspection: returns velocity magnitude of most recently spawned round by ID */
  public getRoundDebugState(
    id: number,
  ): { position: THREE.Vector3; velocity: THREE.Vector3; settled: boolean; kind: LiveRoundVisualKind } | null {
    for (let i = 0; i < this.pool.length; i++) {
      const r = this.pool[i];
      if (r.active && r.id === id) {
        return {
          position: r.root.position.clone(),
          velocity: r.vel.clone(),
          settled: r.settled,
          kind: r.kind,
        };
      }
    }
    return null;
  }

  public clear(): void {
    for (let i = 0; i < this.pool.length; i++) {
      const r = this.pool[i];
      r.active = false;
      r.settled = false;
      r.root.visible = false;
    }
  }

  public dispose(): void {
    this.clear();
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
    for (let i = 0; i < this.disposables.length; i++) {
      this.disposables[i].dispose();
    }
    this.disposables.length = 0;
  }
}

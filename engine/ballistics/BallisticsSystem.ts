import * as THREE from 'three';
import { CALIBERS, CaliberId } from '../../data/calibers';
import { LimbId } from '../../data/traumaConfig';
import { ZombieManager } from '../ai/ZombieManager';
import { AudioEngine } from '../audio/AudioEngine';
import { AcousticSystem } from '../stealth/AcousticSystem';
import { BuiltWorld, SurfaceType } from '../world/WorldBuilder';

interface ActiveProjectile {
  caliberId: CaliberId;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  massKg: number;
  bc: number;
  age: number;
  tracerMesh: THREE.Mesh;
  penetratedIds: Set<string>;
}

interface ImpactParticle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  age: number;
  maxAge: number;
}

export class BallisticsSystem {
  private scene: THREE.Scene;
  private audio: AudioEngine;
  private acoustic: AcousticSystem;
  private zombies: ZombieManager;

  private projectiles: ActiveProjectile[] = [];
  private particles: ImpactParticle[] = [];

  private tracerGeo = new THREE.BoxGeometry(0.012, 0.012, 0.45);
  private tracerMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.78 });
  private sparkGeo = new THREE.BoxGeometry(0.025, 0.025, 0.025);
  private sparkMat = new THREE.MeshBasicMaterial({ color: 0xffb84d });
  private dustMat = new THREE.MeshStandardMaterial({ color: 0x6f6e68, roughness: 1.0 });
  private woodMat = new THREE.MeshStandardMaterial({ color: 0x6c5138, roughness: 0.9 });
  private bloodMat = new THREE.MeshStandardMaterial({ color: 0x5c1816, roughness: 0.65 });

  private raycaster = new THREE.Raycaster();
  private _stepVec = new THREE.Vector3();
  private _dirVec = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    audio: AudioEngine,
    acoustic: AcousticSystem,
    zombies: ZombieManager,
  ) {
    this.scene = scene;
    this.audio = audio;
    this.acoustic = acoustic;
    this.zombies = zombies;
  }

  public spawnShot(muzzlePos: THREE.Vector3, muzzleDir: THREE.Vector3, caliberId: CaliberId): void {
    const spec = CALIBERS[caliberId];
    const massKg = spec.bulletMassGrams / 1000;
    const spreadRad = THREE.MathUtils.degToRad((spec.spreadMOA / 60) * 1.15);

    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(muzzleDir, up).normalize();
    if (right.lengthSq() < 0.001) right.set(1, 0, 0);
    const localUp = new THREE.Vector3().crossVectors(right, muzzleDir).normalize();

    for (let i = 0; i < spec.pellets; i++) {
      const rx = (Math.random() - 0.5) * 2 * spreadRad;
      const ry = (Math.random() - 0.5) * 2 * spreadRad;

      const dir = muzzleDir
        .clone()
        .addScaledVector(right, rx)
        .addScaledVector(localUp, ry)
        .normalize();

      const vel = dir.multiplyScalar(spec.muzzleVelocityMps);
      const tracer = new THREE.Mesh(this.tracerGeo, this.tracerMat);
      tracer.position.copy(muzzlePos);
      tracer.lookAt(muzzlePos.clone().add(vel));
      this.scene.add(tracer);

      this.projectiles.push({
        caliberId,
        pos: muzzlePos.clone(),
        vel,
        massKg,
        bc: spec.ballisticCoefficient,
        age: 0,
        tracerMesh: tracer,
        penetratedIds: new Set<string>(),
      });
    }
  }

  public update(
    delta: number,
    world: BuiltWorld,
    playerSelfHitMeshes?: THREE.Object3D[],
    onPlayerSelfHit?: (
      limbId: LimbId,
      energyJ: number,
      dir: THREE.Vector3,
      pos: THREE.Vector3,
    ) => void,
    onWorldImpact?: (
      obj: THREE.Object3D,
      point: THREE.Vector3,
      normal: THREE.Vector3,
    ) => void,
  ): void {
    const dt = Math.min(delta, 0.04);
    const targets = playerSelfHitMeshes && playerSelfHitMeshes.length > 0
      ? [...world.raycastMeshes, ...this.zombies.getHitMeshes(), ...playerSelfHitMeshes]
      : [...world.raycastMeshes, ...this.zombies.getHitMeshes()];

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.age += dt;
      if (p.age > 2.2) {
        this.removeProjectile(i);
        continue;
      }

      // Gravity + aerodynamic drag derived from caliber's real-world BC
      const speed = p.vel.length();
      if (speed < 18) {
        this.removeProjectile(i);
        continue;
      }
      const dragDecel = (0.00115 * speed * speed) / Math.max(0.02, p.bc);
      const nextSpeed = Math.max(0, speed - dragDecel * dt);
      p.vel.multiplyScalar(nextSpeed / speed);
      p.vel.y -= 9.81 * dt;

      this._stepVec.copy(p.vel).multiplyScalar(dt);
      const stepLen = this._stepVec.length();
      if (stepLen <= 0.0001) continue;

      this._dirVec.copy(this._stepVec).divideScalar(stepLen);
      this.raycaster.set(p.pos, this._dirVec);
      this.raycaster.near = 0;
      this.raycaster.far = stepLen + 0.05;

      const hits = this.raycaster.intersectObjects(targets, false);
      let consumed = false;

      for (const hit of hits) {
        const obj = hit.object;
        const zombieId = obj.userData.zombieId as string | undefined;
        const playerLimb = obj.userData.playerLimb as LimbId | undefined;

        const currentSpeed = p.vel.length();
        const kineticEnergyJ = 0.5 * p.massKg * currentSpeed * currentSpeed;

        if (playerLimb && onPlayerSelfHit) {
          if (hit.distance < 0.08) continue;
          // Ignore grazing own arms/thorax at muzzle exit during valid downward/forward weapon pitch (down to -72°)
          if (
            p.age < 0.035 &&
            this._dirVec.y > -0.95 &&
            (playerLimb === 'leftArm' || playerLimb === 'rightArm' || playerLimb === 'thorax')
          ) {
            continue;
          }
          onPlayerSelfHit(playerLimb, kineticEnergyJ, this._dirVec, hit.point);
          this.audio.playImpact(hit.point, 'flesh');
          this.spawnImpactParticles(
            hit.point,
            hit.face?.normal ?? this._dirVec.clone().negate(),
            'flesh',
          );
          consumed = true;
          break;
        }

        if (zombieId) {
          if (p.penetratedIds.has(zombieId)) continue;
          p.penetratedIds.add(zombieId);

          const hitZone = (obj.userData.hitZone as LimbId) ?? 'thorax';
          this.zombies.applyDamage(zombieId, hitZone, kineticEnergyJ, this._dirVec, hit.point, 'bullet');
          this.audio.playImpact(hit.point, 'flesh');
          this.spawnImpactParticles(hit.point, hit.face?.normal ?? this._dirVec.clone().negate(), 'flesh');
          consumed = true;
          break;
        }

        // World geometry / glass hit
        const objUuid = obj.uuid;
        if (p.penetratedIds.has(objUuid)) continue;

        const windowId = obj.userData.windowId as string | undefined;
        if (windowId) {
          p.penetratedIds.add(objUuid);
          world.shatterWindow(windowId, hit.point, this._dirVec);
          p.vel.multiplyScalar(0.88);
          p.pos.copy(hit.point).addScaledVector(this._dirVec, 0.06);
          continue;
        }

        const surface = (obj.userData.surface as SurfaceType) ?? 'concrete';
        const penetrableWood = Boolean(obj.userData.penetrableWood);
        const caliber = CALIBERS[p.caliberId];

        const normal = hit.face?.normal
          ? hit.face.normal.clone().transformDirection(obj.matrixWorld)
          : this._dirVec.clone().negate();

        if (penetrableWood && kineticEnergyJ >= caliber.woodPenetrationThresholdJ) {
          // Light wood penetration! Reduce energy/velocity and keep flying
          p.penetratedIds.add(objUuid);
          const retain = Math.sqrt(Math.max(0.1, 1 - caliber.penetrationEnergyLossRatio));
          p.vel.multiplyScalar(retain);
          this.audio.playImpact(hit.point, 'wood');
          this.spawnImpactParticles(hit.point, normal, 'wood');
          // Advance slightly past entry face
          p.pos.copy(hit.point).addScaledVector(this._dirVec, 0.08);
          continue;
        }

        // Stop on solid obstacle
        if (onWorldImpact) {
          onWorldImpact(obj, hit.point, normal);
        }
        const audioMat = surface === 'metal' ? 'metal' : surface === 'wood' ? 'wood' : 'concrete';
        this.audio.playImpact(hit.point, audioMat);
        this.spawnImpactParticles(hit.point, normal, surface);
        this.acoustic.emitNoise(hit.point, 5.5, 'impact');
        consumed = true;
        break;
      }

      if (consumed) {
        this.removeProjectile(i);
        continue;
      }

      p.pos.add(this._stepVec);
      p.tracerMesh.position.copy(p.pos);
      p.tracerMesh.lookAt(p.pos.clone().add(p.vel));
    }

    // Update impact particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const pt = this.particles[i];
      pt.age += dt;
      pt.vel.y -= 9.81 * dt;
      pt.mesh.position.addScaledVector(pt.vel, dt);
      if (pt.age >= pt.maxAge) {
        this.scene.remove(pt.mesh);
        this.particles.splice(i, 1);
      }
    }
  }

  private removeProjectile(idx: number): void {
    const p = this.projectiles[idx];
    this.scene.remove(p.tracerMesh);
    this.projectiles.splice(idx, 1);
  }

  public spawnImpactParticles(pos: THREE.Vector3, normal: THREE.Vector3, kind: SurfaceType | 'flesh'): void {
    const count = kind === 'flesh' ? 5 : 6;
    const mat =
      kind === 'metal'
        ? this.sparkMat
        : kind === 'wood'
          ? this.woodMat
          : kind === 'flesh'
            ? this.bloodMat
            : this.dustMat;

    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(this.sparkGeo, mat);
      m.position.copy(pos);
      this.scene.add(m);
      const v = normal
        .clone()
        .multiplyScalar(1.8 + Math.random() * 2.5)
        .add(new THREE.Vector3((Math.random() - 0.5) * 2.6, Math.random() * 2.0, (Math.random() - 0.5) * 2.6));
      this.particles.push({
        mesh: m,
        vel: v,
        age: 0,
        maxAge: kind === 'metal' ? 0.25 : 0.42,
      });
    }
    if (this.particles.length > 90) {
      const old = this.particles.shift()!;
      this.scene.remove(old.mesh);
    }
  }

  public shiftOrigin(shiftX: number, shiftZ: number): void {
    for (const p of this.projectiles) {
      p.pos.x -= shiftX;
      p.pos.z -= shiftZ;
      p.tracerMesh.position.x -= shiftX;
      p.tracerMesh.position.z -= shiftZ;
    }
    for (const pt of this.particles) {
      pt.mesh.position.x -= shiftX;
      pt.mesh.position.z -= shiftZ;
    }
  }

  public dispose(): void {
    for (const p of this.projectiles) {
      this.scene.remove(p.tracerMesh);
    }
    for (const pt of this.particles) {
      this.scene.remove(pt.mesh);
    }
    this.projectiles = [];
    this.particles = [];
    this.tracerGeo.dispose();
    this.tracerMat.dispose();
    this.sparkGeo.dispose();
    this.sparkMat.dispose();
    this.dustMat.dispose();
    this.woodMat.dispose();
    this.bloodMat.dispose();
  }
}

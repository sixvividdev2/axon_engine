import * as THREE from 'three';
import { LimbId } from '../../data/traumaConfig';
import { ZombieManager } from '../ai/ZombieManager';
import { AudioEngine } from '../audio/AudioEngine';
import { VIEWMODEL_LAYER } from '../render/BodycamPostProcess';
import { AcousticSystem } from '../stealth/AcousticSystem';
import { BuiltWorld, SurfaceType } from '../world/WorldBuilder';

export type ThrowableKind = 'rgd5_frag' | 'throw_bolt';

interface ActiveThrowable {
  kind: ThrowableKind;
  mesh: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  angVel: THREE.Vector3;
  fuseRemaining: number;
  age: number;
  settled: boolean;
  emittedLure: boolean;
}

interface BlastParticle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  age: number;
  maxAge: number;
  gravity: number;
}

interface BlastFlash {
  light: THREE.PointLight;
  age: number;
  maxAge: number;
}

export class ThrowableSystem {
  private scene: THREE.Scene;
  private audio: AudioEngine;
  private acoustic: AcousticSystem;
  private zombies: ZombieManager;

  private items: ActiveThrowable[] = [];
  private particles: BlastParticle[] = [];
  private flashes: BlastFlash[] = [];

  private raycaster = new THREE.Raycaster();
  private _step = new THREE.Vector3();
  private _dir = new THREE.Vector3();
  private _normal = new THREE.Vector3();

  // Shared geometries & materials
  private fragBodyGeo = new THREE.SphereGeometry(0.036, 10, 8);
  private fragNeckGeo = new THREE.CylinderGeometry(0.012, 0.015, 0.025, 8);
  private boltShaftGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.055, 6);
  private boltHeadGeo = new THREE.CylinderGeometry(0.015, 0.015, 0.014, 6);
  private boltClothGeo = new THREE.BoxGeometry(0.010, 0.006, 0.048);

  private fragMat = new THREE.MeshStandardMaterial({ color: 0x3f4c34, roughness: 0.65, metalness: 0.25 });
  private steelMat = new THREE.MeshStandardMaterial({ color: 0x5c6066, roughness: 0.35, metalness: 0.85 });
  private clothMat = new THREE.MeshStandardMaterial({ color: 0x998e75, roughness: 0.95, metalness: 0.02 });

  private sparkGeo = new THREE.BoxGeometry(0.035, 0.035, 0.09);
  private sparkMat = new THREE.MeshBasicMaterial({ color: 0xffc663 });
  private smokeGeo = new THREE.DodecahedronGeometry(0.22, 0);
  private smokeMat = new THREE.MeshStandardMaterial({
    color: 0x262624,
    roughness: 1.0,
    transparent: true,
    opacity: 0.72,
  });

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

  public spawnThrowable(
    kind: ThrowableKind,
    startPos: THREE.Vector3,
    velocity: THREE.Vector3,
    remainingFuseSec = 3.5,
  ): void {
    const group = new THREE.Group();
    if (kind === 'rgd5_frag') {
      const body = new THREE.Mesh(this.fragBodyGeo, this.fragMat);
      body.scale.set(0.95, 1.18, 0.95);
      body.castShadow = true;
      const neck = new THREE.Mesh(this.fragNeckGeo, this.steelMat);
      neck.position.set(0, 0.045, 0);
      neck.castShadow = true;
      group.add(body, neck);
    } else {
      const shaft = new THREE.Mesh(this.boltShaftGeo, this.steelMat);
      shaft.rotation.z = Math.PI * 0.5;
      shaft.castShadow = true;
      const head = new THREE.Mesh(this.boltHeadGeo, this.steelMat);
      head.rotation.z = Math.PI * 0.5;
      head.position.set(-0.028, 0, 0);
      head.castShadow = true;
      const cloth = new THREE.Mesh(this.boltClothGeo, this.clothMat);
      cloth.position.set(0.025, 0, 0.015);
      group.add(shaft, head, cloth);
    }

    group.position.copy(startPos);
    this.scene.add(group);

    this.items.push({
      kind,
      mesh: group,
      pos: startPos.clone(),
      vel: velocity.clone(),
      angVel: new THREE.Vector3(
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
      ),
      fuseRemaining: Math.max(0.15, remainingFuseSec),
      age: 0,
      settled: false,
      emittedLure: false,
    });
  }

  public update(
    delta: number,
    world: BuiltWorld,
    playerPos: THREE.Vector3,
    onPlayerBlastDamage: (damage: number, bleedChance: number, origin: THREE.Vector3) => void,
  ): void {
    const dt = Math.min(delta, 0.05);
    const targets = [...world.raycastMeshes, ...this.zombies.getHitMeshes()];

    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.age += dt;

      if (it.kind === 'rgd5_frag') {
        it.fuseRemaining -= dt;
        if (it.fuseRemaining <= 0) {
          this.detonateFrag(it.pos, world, playerPos, onPlayerBlastDamage);
          this.scene.remove(it.mesh);
          this.items.splice(i, 1);
          continue;
        }
      } else if (it.age > 9.0) {
        this.scene.remove(it.mesh);
        this.items.splice(i, 1);
        continue;
      }

      if (!it.settled) {
        it.vel.y -= 9.81 * dt;
        it.vel.multiplyScalar(Math.max(0, 1 - 0.12 * dt));

        this._step.copy(it.vel).multiplyScalar(dt);
        const stepLen = this._step.length();

        if (stepLen > 0.0005) {
          this._dir.copy(this._step).divideScalar(stepLen);
          this.raycaster.set(it.pos, this._dir);
          this.raycaster.near = 0;
          this.raycaster.far = stepLen + 0.05;

          const hits = this.raycaster.intersectObjects(targets, false);
          if (hits.length > 0) {
            const hit = hits[0];
            const obj = hit.object;

            const windowId = obj.userData.windowId as string | undefined;
            if (windowId && it.vel.length() > 3.5) {
              world.shatterWindow(windowId, hit.point, this._dir);
              it.vel.multiplyScalar(0.75);
              it.pos.copy(hit.point).addScaledVector(this._dir, 0.06);
            } else {
              if (hit.face?.normal) {
                this._normal.copy(hit.face.normal).transformDirection(obj.matrixWorld).normalize();
              } else {
                this._normal.set(0, 1, 0);
              }

              const impactSpeed = it.vel.length();
              const surf = (obj.userData.surface as SurfaceType) ?? 'concrete';
              if (impactSpeed > 1.35) {
                if (it.kind === 'throw_bolt') {
                  this.audio.playImpact(hit.point, surf === 'wood' ? 'wood' : 'metal');
                  // Silent sound-distraction lure for zombies near impact point!
                  if (!it.emittedLure) {
                    it.emittedLure = true;
                    this.acoustic.emitNoise(hit.point, 20, 'impact');
                  } else {
                    this.acoustic.emitNoise(hit.point, 9, 'impact');
                  }
                } else {
                  this.audio.playImpact(hit.point, surf === 'metal' ? 'metal' : surf === 'wood' ? 'wood' : 'concrete');
                  this.acoustic.emitNoise(hit.point, 10, 'impact');
                }
              }

              const zombieId = obj.userData.zombieId as string | undefined;
              if (zombieId && impactSpeed > 4.0) {
                const hitZone = (obj.userData.hitZone as LimbId) ?? 'thorax';
                this.zombies.applyDamage(zombieId, hitZone, 18, this._dir, hit.point, 'blunt');
              }

              // Bounce with restitution
              const restitution = surf === 'grass' ? 0.22 : 0.36;
              const vn = it.vel.dot(this._normal);
              if (vn < 0) {
                it.vel.addScaledVector(this._normal, -(1 + restitution) * vn);
              }
              it.vel.multiplyScalar(0.72);
              it.angVel.multiplyScalar(0.65);
              it.pos.copy(hit.point).addScaledVector(this._normal, 0.04);

              if (it.vel.lengthSq() < 0.35 && this._normal.y > 0.6) {
                it.settled = true;
                it.vel.set(0, 0, 0);
              }
            }
          } else {
            it.pos.add(this._step);
          }
        }

        // Ground height clamp so throwables never fall through terrain
        const groundY = world.groundHeightAt(it.pos.x, it.pos.z) + 0.035;
        if (it.pos.y <= groundY) {
          if (it.vel.y < -1.4) {
            const surf = world.surfaceAt(it.pos.x, it.pos.z);
            if (it.kind === 'throw_bolt') {
              this.audio.playImpact(it.pos, surf === 'grass' ? 'wood' : 'metal');
              if (!it.emittedLure) {
                it.emittedLure = true;
                this.acoustic.emitNoise(it.pos, surf === 'grass' ? 14 : 22, 'impact');
              }
            } else {
              this.audio.playImpact(it.pos, surf === 'grass' ? 'wood' : 'concrete');
              this.acoustic.emitNoise(it.pos, 9, 'impact');
            }
          }
          it.pos.y = groundY;
          if (Math.abs(it.vel.y) < 0.75) {
            it.vel.y = 0;
            it.vel.x *= 0.65;
            it.vel.z *= 0.65;
            if (it.vel.lengthSq() < 0.08) {
              it.settled = true;
              it.vel.set(0, 0, 0);
            }
          } else {
            it.vel.y = -it.vel.y * 0.28;
            it.vel.x *= 0.72;
            it.vel.z *= 0.72;
          }
        }

        it.mesh.position.copy(it.pos);
        it.mesh.rotation.x += it.angVel.x * dt;
        it.mesh.rotation.y += it.angVel.y * dt;
        it.mesh.rotation.z += it.angVel.z * dt;
      }
    }

    // Update blast particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      p.vel.y -= p.gravity * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      if (p.age >= p.maxAge) {
        this.scene.remove(p.mesh);
        this.particles.splice(i, 1);
      }
    }

    // Update blast flashes
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.age += dt;
      const t = THREE.MathUtils.clamp(f.age / f.maxAge, 0, 1);
      f.light.intensity = 34 * (1 - t) * (1 - t);
      if (f.age >= f.maxAge) {
        this.scene.remove(f.light);
        this.flashes.splice(i, 1);
      }
    }
  }

  private detonateFrag(
    origin: THREE.Vector3,
    world: BuiltWorld,
    playerPos: THREE.Vector3,
    onPlayerBlastDamage: (damage: number, bleedChance: number, origin: THREE.Vector3) => void,
  ): void {
    // 1. Massive 200m acoustic spike + mic-clipping explosion audio
    this.audio.playExplosion(origin);
    this.acoustic.emitNoise(origin, 200, 'explosion');

    // 2. Shrapnel / kinetic blast against zombies (9.5m lethal radius)
    this.zombies.applyExplosion(origin, 9.5, 4200, world);

    // 3. Shatter nearby glass windows within 7.5m
    for (const obj of [...world.raycastMeshes]) {
      const windowId = obj.userData.windowId as string | undefined;
      if (!windowId) continue;
      const wp = new THREE.Vector3();
      obj.getWorldPosition(wp);
      if (wp.distanceTo(origin) < 7.5) {
        const dir = wp.clone().sub(origin).normalize();
        world.shatterWindow(windowId, wp, dir);
      }
    }

    // 4. Player proximity blast damage (with wall LoS check)
    const playerEye = new THREE.Vector3(playerPos.x, playerPos.y + 1.1, playerPos.z);
    const pDist = playerEye.distanceTo(origin);
    if (pDist < 6.5) {
      const dir = playerEye.clone().sub(origin);
      let blocked = false;
      if (pDist > 0.25) {
        dir.divideScalar(pDist);
        this.raycaster.set(origin, dir);
        this.raycaster.near = 0.08;
        this.raycaster.far = pDist - 0.15;
        const hits = this.raycaster.intersectObjects(world.raycastMeshes, false);
        blocked = hits.some((h) => !h.object.userData.isGlass);
      }
      if (!blocked) {
        const dmg = 85 * Math.pow(1 - pDist / 6.5, 1.35);
        if (dmg > 4) {
          onPlayerBlastDamage(dmg, 0.75, origin);
        }
      }
    }

    // 5. HDR Explosion Flash & Shrapnel/Smoke Particles
    const light = new THREE.PointLight(0xffb454, 34, 28, 1.4);
    light.layers.enable(VIEWMODEL_LAYER);
    light.position.copy(origin).setY(origin.y + 0.35);
    this.scene.add(light);
    this.flashes.push({ light, age: 0, maxAge: 0.24 });

    for (let i = 0; i < 20; i++) {
      const mesh = new THREE.Mesh(this.sparkGeo, this.sparkMat);
      mesh.position.copy(origin).setY(origin.y + 0.12);
      const speed = 7 + Math.random() * 16;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 0.48;
      const vel = new THREE.Vector3(
        Math.cos(theta) * Math.cos(phi) * speed,
        Math.sin(phi) * speed + 2.0,
        Math.sin(theta) * Math.cos(phi) * speed,
      );
      mesh.lookAt(mesh.position.clone().add(vel));
      this.scene.add(mesh);
      this.particles.push({ mesh, vel, age: 0, maxAge: 0.32 + Math.random() * 0.25, gravity: 9.81 });
    }

    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(this.smokeGeo, this.smokeMat);
      mesh.position.copy(origin).add(
        new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.2 + Math.random() * 0.4, (Math.random() - 0.5) * 0.8),
      );
      mesh.scale.setScalar(0.8 + Math.random() * 1.4);
      const vel = new THREE.Vector3((Math.random() - 0.5) * 2.2, 1.6 + Math.random() * 2.2, (Math.random() - 0.5) * 2.2);
      this.scene.add(mesh);
      this.particles.push({ mesh, vel, age: 0, maxAge: 0.9 + Math.random() * 0.7, gravity: -0.6 });
    }
  }

  public shiftOrigin(shiftX: number, shiftZ: number): void {
    for (const it of this.items) {
      it.pos.x -= shiftX;
      it.pos.z -= shiftZ;
      it.mesh.position.x -= shiftX;
      it.mesh.position.z -= shiftZ;
    }
    for (const p of this.particles) {
      p.mesh.position.x -= shiftX;
      p.mesh.position.z -= shiftZ;
    }
    for (const f of this.flashes) {
      f.light.position.x -= shiftX;
      f.light.position.z -= shiftZ;
    }
  }

  public dispose(): void {
    for (const it of this.items) this.scene.remove(it.mesh);
    for (const p of this.particles) this.scene.remove(p.mesh);
    for (const f of this.flashes) this.scene.remove(f.light);
    this.items = [];
    this.particles = [];
    this.flashes = [];
    this.fragBodyGeo.dispose();
    this.fragNeckGeo.dispose();
    this.boltShaftGeo.dispose();
    this.boltHeadGeo.dispose();
    this.boltClothGeo.dispose();
    this.fragMat.dispose();
    this.steelMat.dispose();
    this.clothMat.dispose();
    this.sparkGeo.dispose();
    this.sparkMat.dispose();
    this.smokeGeo.dispose();
    this.smokeMat.dispose();
  }
}

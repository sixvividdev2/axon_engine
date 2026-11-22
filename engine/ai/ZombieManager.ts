import * as THREE from 'three';
import { BodycamMeleeHitEvent } from '../../bodycam-sdk/types';
import { AI_ARCHETYPES, AiArchetypeId, AiArchetypeSpec } from '../../data/aiArchetypes';
import { LimbId } from '../../data/traumaConfig';
import { AudioEngine } from '../audio/AudioEngine';
import { AcousticEvent, AcousticSystem } from '../stealth/AcousticSystem';
import { LimbTraumaSystem, TraumaDamageKind } from '../trauma/LimbTraumaSystem';
import { ZombieSaveState, ZombieStateName } from '../types';
import { BuiltWorld } from '../world/WorldBuilder';

export interface ZombieActor {
  id: string;
  chunkKey?: string;
  archetype: AiArchetypeSpec;
  group: THREE.Group;
  headMesh: THREE.Mesh;
  torsoMesh: THREE.Mesh;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Mesh;
  rightLeg: THREE.Mesh;
  debugCone: THREE.Mesh;
  actorHitMeshes: THREE.Object3D[];
  actorGeos: THREE.BufferGeometry[];
  actorMats: THREE.Material[];
  trauma: LimbTraumaSystem;
  hp: number;
  state: ZombieStateName;
  yaw: number;
  investigateTarget: THREE.Vector3 | null;
  wanderTarget: THREE.Vector3;
  wanderWaitTimer: number;
  investigateTimer: number;
  attackCooldown: number;
  staggerTimer: number;
  staggerTotalSec: number;
  staggerKind: 'none' | 'head_snap' | 'kick_stumble' | 'generic';
  knockbackVelX: number;
  knockbackVelZ: number;
  deathProgress: number;
  gaitPhase: number;
  nextVocalMs: number;
  lastSeenPlayerTimer: number;
}

export interface ChunkZombieSpawnDef {
  id: string;
  archetypeId: AiArchetypeId;
  worldX: number;
  worldY: number;
  worldZ: number;
  yaw: number;
}

export class ZombieManager {
  private scene: THREE.Scene;
  private audio: AudioEngine;
  private zombies: ZombieActor[] = [];
  private hitMeshes: THREE.Object3D[] = [];
  private savedArchive = new Map<string, ZombieSaveState>();
  private unsubscribeAcoustic: (() => void) | null = null;
  private debugEnabled = false;

  // Shared 32-mesh blood decal pool for all AI zombies (zero per-zombie GPU/scene overhead)
  private sharedBloodPool: LimbTraumaSystem;
  private readonly spawnBloodDecalCb = (x: number, y: number, z: number, scale: number): void => {
    this.sharedBloodPool.spawnBloodDecal(x, y, z, scale);
  };

  private raycaster = new THREE.Raycaster();
  private _dir = new THREE.Vector3();
  private _origin = new THREE.Vector3();
  private _target = new THREE.Vector3();

  private lastWorldRef: BuiltWorld | null = null;

  constructor(scene: THREE.Scene, audio: AudioEngine, acoustic: AcousticSystem) {
    this.scene = scene;
    this.audio = audio;
    this.sharedBloodPool = new LimbTraumaSystem(scene);
    this.unsubscribeAcoustic = acoustic.subscribe((ev) => this.onAcousticEvent(ev));
  }

  public setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
    for (const z of this.zombies) {
      z.debugCone.visible = enabled && z.state !== 'DEAD';
    }
  }

  public getHitMeshes(): THREE.Object3D[] {
    return this.hitMeshes;
  }

  public resetForWorld(world: BuiltWorld, savedStates?: ZombieSaveState[]): void {
    this.clear();
    this.lastWorldRef = world;
    if (savedStates) {
      for (const s of savedStates) {
        this.savedArchive.set(s.id, {
          ...s,
          position: [...s.position] as [number, number, number],
          investigateTarget: s.investigateTarget
            ? ([...s.investigateTarget] as [number, number, number])
            : null,
          trauma: s.trauma
            ? {
                painkillerRemainingSec: s.trauma.painkillerRemainingSec,
                limbs: {
                  head: { ...s.trauma.limbs.head },
                  thorax: { ...s.trauma.limbs.thorax },
                  leftArm: { ...s.trauma.limbs.leftArm },
                  rightArm: { ...s.trauma.limbs.rightArm },
                  leftLeg: { ...s.trauma.limbs.leftLeg },
                  rightLeg: { ...s.trauma.limbs.rightLeg },
                },
              }
            : undefined,
        });
      }
    }
  }

  public onChunkReady(
    world: BuiltWorld,
    chunkKey: string,
    spawns: ChunkZombieSpawnDef[],
    killedIds: Set<string>,
  ): void {
    this.lastWorldRef = world;
    const ox = world.chunkManager.originX;
    const oz = world.chunkManager.originZ;

    for (const sp of spawns) {
      if (killedIds.has(sp.id)) continue;
      if (this.zombies.some((z) => z.id === sp.id)) continue;

      const saved = this.savedArchive.get(sp.id);
      if (saved) {
        this.savedArchive.delete(sp.id);
        if (saved.state === 'DEAD') continue;

        const localPos = new THREE.Vector3(
          saved.position[0] - ox,
          saved.position[1],
          saved.position[2] - oz,
        );
        const invLocal: [number, number, number] | null = saved.investigateTarget
          ? [saved.investigateTarget[0] - ox, saved.investigateTarget[1], saved.investigateTarget[2] - oz]
          : null;
        this.spawnZombie(
          sp.id,
          saved.archetypeId,
          localPos,
          saved.yaw,
          saved.hp,
          saved.state,
          invLocal,
          chunkKey,
          saved.trauma,
        );
      } else {
        const localPos = new THREE.Vector3(sp.worldX - ox, sp.worldY, sp.worldZ - oz);
        this.spawnZombie(sp.id, sp.archetypeId, localPos, sp.yaw, undefined, undefined, undefined, chunkKey);
      }
    }
  }

  public onChunkUnloaded(chunkKey: string, originX: number, originZ: number): void {
    for (let i = this.zombies.length - 1; i >= 0; i--) {
      const z = this.zombies[i];
      if (z.chunkKey !== chunkKey) continue;

      if (z.state !== 'DEAD') {
        this.savedArchive.set(z.id, {
          id: z.id,
          archetypeId: z.archetype.id,
          position: [z.group.position.x + originX, z.group.position.y, z.group.position.z + originZ],
          yaw: z.yaw,
          hp: z.hp,
          state: z.state,
          investigateTarget: z.investigateTarget
            ? [
                z.investigateTarget.x + originX,
                z.investigateTarget.y,
                z.investigateTarget.z + originZ,
              ]
            : null,
          trauma: z.trauma.exportSaveState(),
        });
      }

      this.removeZombieAt(i);
    }
  }

  private removeZombieAt(idx: number): void {
    const z = this.zombies[idx];
    this.scene.remove(z.group);
    for (const hm of z.actorHitMeshes) {
      const hIdx = this.hitMeshes.indexOf(hm);
      if (hIdx !== -1) this.hitMeshes.splice(hIdx, 1);
    }
    for (const g of z.actorGeos) g.dispose();
    for (const m of z.actorMats) m.dispose();
    this.zombies.splice(idx, 1);
  }

  private spawnZombie(
    id: string,
    archetypeId: AiArchetypeId,
    pos: THREE.Vector3,
    yaw: number,
    hpOverride?: number,
    stateOverride?: ZombieStateName,
    investigateOverride?: [number, number, number] | null,
    chunkKey?: string,
    traumaSave?: ZombieSaveState['trauma'],
  ): void {
    const spec = AI_ARCHETYPES[archetypeId];
    const s = spec.bodyScale;
    const group = new THREE.Group();
    group.position.copy(pos);
    group.rotation.y = yaw;
    this.scene.add(group);

    const actorGeos: THREE.BufferGeometry[] = [];
    const actorMats: THREE.Material[] = [];

    const skinMat = new THREE.MeshStandardMaterial({ color: spec.skinColorHex, roughness: 0.9, metalness: 0.04 });
    const clothMat = new THREE.MeshStandardMaterial({ color: spec.clothColorHex, roughness: 0.94, metalness: 0.02 });
    const eyeMat = new THREE.MeshBasicMaterial({ color: spec.eyeGlowHex });
    actorMats.push(skinMat, clothMat, eyeMat);

    // Legs (bottom-center grounded) — tagged with leftLeg / rightLeg hit zones
    const legGeo = new THREE.BoxGeometry(0.16 * s, 0.78 * s, 0.18 * s);
    legGeo.translate(0, -0.39 * s, 0);
    actorGeos.push(legGeo);

    const leftLeg = new THREE.Mesh(legGeo, clothMat);
    leftLeg.position.set(-0.12 * s, 0.80 * s, 0);
    leftLeg.castShadow = true;
    leftLeg.userData.zombieId = id;
    leftLeg.userData.hitZone = 'leftLeg' satisfies LimbId;

    const rightLeg = new THREE.Mesh(legGeo, clothMat);
    rightLeg.position.set(0.12 * s, 0.80 * s, 0);
    rightLeg.castShadow = true;
    rightLeg.userData.zombieId = id;
    rightLeg.userData.hitZone = 'rightLeg' satisfies LimbId;
    group.add(leftLeg, rightLeg);

    // Hunched Torso
    const torsoGeo = new THREE.BoxGeometry(0.46 * s, 0.68 * s, 0.26 * s);
    actorGeos.push(torsoGeo);
    const torsoMesh = new THREE.Mesh(torsoGeo, clothMat);
    torsoMesh.position.set(0, 1.12 * s, 0.03 * s);
    torsoMesh.rotation.x = 0.18;
    torsoMesh.castShadow = true;
    torsoMesh.receiveShadow = true;
    torsoMesh.userData.zombieId = id;
    torsoMesh.userData.hitZone = 'thorax' satisfies LimbId;
    group.add(torsoMesh);

    // Shoulders
    const shoulderGeo = new THREE.BoxGeometry(0.54 * s, 0.18 * s, 0.24 * s);
    actorGeos.push(shoulderGeo);
    const shoulders = new THREE.Mesh(shoulderGeo, clothMat);
    shoulders.position.set(0, 1.40 * s, 0.08 * s);
    group.add(shoulders);

    // Head Hitbox + Pale Eyes
    const headGeo = new THREE.BoxGeometry(0.24 * s, 0.27 * s, 0.25 * s);
    actorGeos.push(headGeo);
    const headMesh = new THREE.Mesh(headGeo, skinMat);
    headMesh.position.set(0, 1.62 * s, 0.14 * s);
    headMesh.rotation.x = 0.12;
    headMesh.castShadow = true;
    headMesh.userData.zombieId = id;
    headMesh.userData.hitZone = 'head' satisfies LimbId;
    group.add(headMesh);

    const eyeGeo = new THREE.BoxGeometry(0.032 * s, 0.022 * s, 0.02 * s);
    actorGeos.push(eyeGeo);
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
    eyeL.position.set(-0.055 * s, 0.02 * s, 0.125 * s);
    const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
    eyeR.position.set(0.055 * s, 0.02 * s, 0.125 * s);
    headMesh.add(eyeL, eyeR);

    // Reaching Arms — tagged with leftArm / rightArm hit zones
    const armGeo = new THREE.BoxGeometry(0.12 * s, 0.62 * s, 0.12 * s);
    armGeo.translate(0, -0.26 * s, 0);
    actorGeos.push(armGeo);

    const leftArm = new THREE.Group();
    leftArm.position.set(-0.30 * s, 1.38 * s, 0.08 * s);
    leftArm.rotation.x = -1.15;
    const leftArmMesh = new THREE.Mesh(armGeo, skinMat);
    leftArmMesh.castShadow = true;
    leftArmMesh.userData.zombieId = id;
    leftArmMesh.userData.hitZone = 'leftArm' satisfies LimbId;
    leftArm.add(leftArmMesh);

    const rightArm = new THREE.Group();
    rightArm.position.set(0.30 * s, 1.38 * s, 0.08 * s);
    rightArm.rotation.x = -1.25;
    const rightArmMesh = new THREE.Mesh(armGeo, skinMat);
    rightArmMesh.castShadow = true;
    rightArmMesh.userData.zombieId = id;
    rightArmMesh.userData.hitZone = 'rightArm' satisfies LimbId;
    rightArm.add(rightArmMesh);
    group.add(leftArm, rightArm);

    // Debug Stealth Vision Cone
    const coneHalfRad = THREE.MathUtils.degToRad(spec.visionConeDeg * 0.5);
    const coneGeo = new THREE.ConeGeometry(Math.tan(coneHalfRad) * spec.visionRangeM, spec.visionRangeM, 18, 1, true);
    coneGeo.translate(0, -spec.visionRangeM * 0.5, 0);
    coneGeo.rotateX(Math.PI / 2);
    actorGeos.push(coneGeo);
    const coneMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      wireframe: true,
      transparent: true,
      opacity: 0.28,
    });
    actorMats.push(coneMat);
    const debugCone = new THREE.Mesh(coneGeo, coneMat);
    debugCone.position.set(0, 1.35 * s, 0.1);
    debugCone.visible = this.debugEnabled && stateOverride !== 'DEAD';
    group.add(debugCone);

    const actorHitMeshes: THREE.Object3D[] = [
      headMesh,
      torsoMesh,
      leftArmMesh,
      rightArmMesh,
      leftLeg,
      rightLeg,
    ];
    this.hitMeshes.push(...actorHitMeshes);

    const state = stateOverride ?? 'IDLE_WANDER';
    const hpScale = archetypeId === 'infected_stalker' ? 0.85 : 1.0;
    const trauma = new LimbTraumaSystem(undefined, hpScale, this.spawnBloodDecalCb);
    if (traumaSave) {
      trauma.loadSaveState(traumaSave);
    } else if (hpOverride !== undefined) {
      const legacyPct = THREE.MathUtils.clamp((hpOverride / Math.max(1, spec.maxHp)) * 100, 0, 100);
      trauma.loadSaveState(undefined, legacyPct, false);
    }

    const hp = Math.round(trauma.getModifiersReadOnly().normalizedHealth);

    const actor: ZombieActor = {
      id,
      chunkKey,
      archetype: spec,
      group,
      headMesh,
      torsoMesh,
      leftArm,
      rightArm,
      leftLeg,
      rightLeg,
      debugCone,
      actorHitMeshes,
      actorGeos,
      actorMats,
      trauma,
      hp,
      state,
      yaw,
      investigateTarget: investigateOverride ? new THREE.Vector3(...investigateOverride) : null,
      wanderTarget: pos.clone(),
      wanderWaitTimer: 1 + Math.random() * 2.5,
      investigateTimer: 0,
      attackCooldown: 0,
      staggerTimer: 0,
      staggerTotalSec: 0,
      staggerKind: 'none',
      knockbackVelX: 0,
      knockbackVelZ: 0,
      deathProgress: state === 'DEAD' ? 1 : 0,
      gaitPhase: Math.random() * Math.PI * 2,
      nextVocalMs: performance.now() + 2000 + Math.random() * 6000,
      lastSeenPlayerTimer: 0,
    };

    if (state === 'DEAD') {
      for (const m of actorHitMeshes) m.userData.zombieDead = true;
      group.rotation.x = -Math.PI * 0.48;
      group.position.y += 0.15;
    }

    this.zombies.push(actor);
  }

  private onAcousticEvent(event: AcousticEvent): void {
    for (const z of this.zombies) {
      if (z.state === 'DEAD' || z.state === 'CHASE' || z.state === 'ATTACK') continue;

      const dist = z.group.position.distanceTo(event.position);
      let effectiveRadius = event.radiusMeters * z.archetype.hearingSensitivity;

      // Wall occlusion damping if sound originates across solid wall
      if (this.lastWorldRef && dist > 2 && dist <= effectiveRadius) {
        this._origin.copy(event.position).setY(event.position.y + 1.0);
        this._target.copy(z.group.position).setY(z.group.position.y + 1.3);
        this._dir.subVectors(this._target, this._origin);
        const rayDist = this._dir.length();
        this._dir.divideScalar(Math.max(0.001, rayDist));
        this.raycaster.set(this._origin, this._dir);
        this.raycaster.near = 0.2;
        this.raycaster.far = rayDist - 0.2;
        const hits = this.raycaster.intersectObjects(this.lastWorldRef.raycastMeshes, false);
        if (hits.some((h) => !h.object.userData.isGlass)) {
          effectiveRadius *= 0.62;
        }
      }

      if (dist <= effectiveRadius) {
        const strength = 1 - dist / Math.max(1, effectiveRadius);
        if (strength >= z.archetype.hearingThreshold) {
          z.state = 'INVESTIGATE';
          z.investigateTarget = event.position.clone();
          z.investigateTimer = 7.5;
          if (Math.random() < 0.45) {
            this.audio.playZombieVocal(z.group.position, 'rasp');
          }
        }
      }
    }
  }

  private markZombieDead(z: ZombieActor): void {
    z.state = 'DEAD';
    z.hp = 0;
    z.knockbackVelX = 0;
    z.knockbackVelZ = 0;
    z.staggerTimer = 0;
    z.staggerKind = 'none';
    for (const m of z.actorHitMeshes) {
      m.userData.zombieDead = true;
    }
    z.debugCone.visible = false;
    this.audio.playZombieVocal(z.group.position, 'hurt');
    if (this.lastWorldRef) {
      if (z.chunkKey) {
        const delta = this.lastWorldRef.chunkManager.getOrCreateDelta(z.chunkKey);
        if (!delta.killedZombieIds.includes(z.id)) {
          delta.killedZombieIds.push(z.id);
        }
      } else {
        this.lastWorldRef.chunkManager.markZombieKilled(
          z.group.position.x + this.lastWorldRef.chunkManager.originX,
          z.group.position.z + this.lastWorldRef.chunkManager.originZ,
          z.id,
        );
      }
    }
  }

  public applyDamage(
    zombieId: string,
    hitZone: LimbId,
    energyJ: number,
    impactDir: THREE.Vector3,
    impactPos: THREE.Vector3,
    damageKind: TraumaDamageKind = 'bullet',
  ): { killed: boolean; headshot: boolean } {
    const z = this.zombies.find((a) => a.id === zombieId);
    if (!z || z.state === 'DEAD') return { killed: false, headshot: false };

    const baseDamage = energyJ / 16.5;
    const mult = hitZone === 'head' ? z.archetype.headshotMultiplier : 1.0;
    const rawDamage = baseDamage * mult;
    const groundY = this.lastWorldRef
      ? this.lastWorldRef.groundHeightAt(z.group.position.x, z.group.position.z)
      : z.group.position.y;

    const hitRes = z.trauma.applyDamageToLimb(
      hitZone,
      rawDamage,
      damageKind,
      energyJ,
      undefined,
      impactPos,
      groundY,
    );
    const mod = z.trauma.getModifiersReadOnly();
    z.hp = Math.round(mod.normalizedHealth);

    if (
      energyJ >= z.archetype.staggerThresholdJ ||
      hitZone === 'head' ||
      hitRes.triggeredFracture
    ) {
      z.staggerTimer = Math.max(z.staggerTimer, hitZone === 'head' ? 0.48 : 0.34);
    }

    if (mod.alive && z.state !== 'CHASE' && z.state !== 'ATTACK') {
      z.state = 'INVESTIGATE';
      z.investigateTarget = impactPos.clone().addScaledVector(impactDir, -14);
      z.investigateTimer = 8.0;
      this.audio.playZombieVocal(z.group.position, 'hurt');
    }

    if (!mod.alive) {
      this.markZombieDead(z);
      return { killed: true, headshot: hitZone === 'head' };
    }

    return { killed: false, headshot: hitZone === 'head' };
  }

  /**
   * Dedicated unarmed punch / weapon bash / tactical push-kick hit response:
   * - Jab / Cross: HEAD hits deal blunt damage + brief head-snap stun (~0.65s);
   *   thorax/arm/leg blows deal damage ONLY (NO stun — zombies push right through body shots).
   * - Push-Kick: moderate blunt trauma + smooth physical knockback (~1.1–1.5m well-placed,
   *   scaled down on glancing hits) + brief stumble stun (~0.95s) interrupting attacks/chase.
   * - Armed Bash: moderate trauma + short pushback + brief stun.
   */
  public applyMeleeHit(
    zombieId: string,
    hitZone: LimbId,
    event: Readonly<BodycamMeleeHitEvent>,
  ): { killed: boolean; headshot: boolean; stunned: boolean } {
    const z = this.zombies.find((a) => a.id === zombieId);
    if (!z || z.state === 'DEAD') {
      return { killed: false, headshot: false, stunned: false };
    }

    const baseDamage = event.damageEnergyJ / 16.5;
    const mult = hitZone === 'head' ? z.archetype.headshotMultiplier : 1.0;
    const rawDamage = baseDamage * mult;
    const groundY = this.lastWorldRef
      ? this.lastWorldRef.groundHeightAt(z.group.position.x, z.group.position.z)
      : z.group.position.y;

    z.trauma.applyDamageToLimb(
      hitZone,
      rawDamage,
      'blunt',
      event.damageEnergyJ,
      undefined,
      event.point as THREE.Vector3,
      groundY,
    );
    const mod = z.trauma.getModifiersReadOnly();
    z.hp = Math.round(mod.normalizedHealth);

    let stunned = false;
    const isPunch = event.attackType === 'jab' || event.attackType === 'cross';

    if (isPunch) {
      // STRICT LOCATIONAL PUNCH STUN RULE: ONLY head strikes trigger a stun/stagger.
      if (hitZone === 'head' && event.stunDurationSec > 0.01) {
        const dur = event.stunDurationSec;
        z.staggerTimer = Math.max(z.staggerTimer, dur);
        z.staggerTotalSec = Math.max(z.staggerTotalSec, dur);
        z.staggerKind = 'head_snap';
        z.attackCooldown = Math.max(z.attackCooldown, dur + 0.16);
        stunned = true;
      }
      // Body/limb blows: damage only — intentionally zero stagger and zero attack interruption.
    } else if (event.attackType === 'kick') {
      // Smooth damped knockback velocity along horizontal kick vector (v0 / 5.4 ≈ 1.1m–1.5m well-placed)
      const hx = event.direction.x;
      const hz = event.direction.z;
      const hLen = Math.hypot(hx, hz);
      if (hLen > 1e-4 && event.knockbackForce > 0) {
        const nx = hx / hLen;
        const nz = hz / hLen;
        z.knockbackVelX += nx * event.knockbackForce;
        z.knockbackVelZ += nz * event.knockbackForce;
        const spd = Math.hypot(z.knockbackVelX, z.knockbackVelZ);
        if (spd > 8.6) {
          const clampScale = 8.6 / spd;
          z.knockbackVelX *= clampScale;
          z.knockbackVelZ *= clampScale;
        }
      }
      if (event.stunDurationSec > 0.01) {
        const dur = event.stunDurationSec;
        z.staggerTimer = Math.max(z.staggerTimer, dur);
        z.staggerTotalSec = Math.max(z.staggerTotalSec, dur);
        z.staggerKind = 'kick_stumble';
        z.attackCooldown = Math.max(z.attackCooldown, dur + 0.22);
        stunned = true;
      }
    } else {
      // Armed V quick-bash
      const hx = event.direction.x;
      const hz = event.direction.z;
      const hLen = Math.hypot(hx, hz);
      if (hLen > 1e-4 && event.knockbackForce > 0) {
        z.knockbackVelX += (hx / hLen) * event.knockbackForce;
        z.knockbackVelZ += (hz / hLen) * event.knockbackForce;
      }
      if (event.stunDurationSec > 0.01) {
        const dur = event.stunDurationSec;
        z.staggerTimer = Math.max(z.staggerTimer, dur);
        z.staggerTotalSec = Math.max(z.staggerTotalSec, dur);
        z.staggerKind = hitZone === 'head' ? 'head_snap' : 'generic';
        z.attackCooldown = Math.max(z.attackCooldown, dur + 0.14);
        stunned = true;
      }
    }

    if (mod.alive) {
      if (z.state !== 'CHASE' && z.state !== 'ATTACK') {
        z.state = 'INVESTIGATE';
        z.investigateTarget = (event.point as THREE.Vector3)
          .clone()
          .addScaledVector(event.direction as THREE.Vector3, -3.5);
        z.investigateTimer = 8.0;
      }
      if (stunned || Math.random() < 0.4) {
        this.audio.playZombieVocal(z.group.position, 'hurt');
      }
    }

    if (!mod.alive) {
      this.markZombieDead(z);
      return { killed: true, headshot: hitZone === 'head', stunned };
    }

    return { killed: false, headshot: hitZone === 'head', stunned };
  }

  public applyExplosion(
    origin: THREE.Vector3,
    radiusM: number,
    maxEnergyJ: number,
    world: BuiltWorld,
  ): number {
    let kills = 0;
    for (const z of this.zombies) {
      if (z.state === 'DEAD') continue;
      this._target.copy(z.group.position).setY(z.group.position.y + 1.0);
      this._dir.subVectors(this._target, origin);
      const dist = this._dir.length();
      if (dist > radiusM) continue;

      if (dist > 0.25) {
        this._dir.divideScalar(dist);
        this.raycaster.set(origin, this._dir);
        this.raycaster.near = 0.08;
        this.raycaster.far = dist - 0.15;
        const wallHits = this.raycaster.intersectObjects(world.raycastMeshes, false);
        if (wallHits.some((h) => !h.object.userData.isGlass)) {
          continue;
        }
      } else {
        this._dir.set(0, 1, 0);
      }

      const falloff = Math.pow(1 - dist / radiusM, 1.35);
      const energyJ = maxEnergyJ * falloff;
      if (energyJ < 40) continue;

      const groundY = world.groundHeightAt(z.group.position.x, z.group.position.z);
      const baseDmg = energyJ / 22.0;
      const fatal = z.trauma.applyBlastDamage(baseDmg, 0.72, z.group.position, groundY);
      const mod = z.trauma.getModifiersReadOnly();
      z.hp = Math.round(mod.normalizedHealth);

      if (fatal || !mod.alive) {
        this.markZombieDead(z);
        kills++;
      } else {
        z.staggerTimer = Math.max(z.staggerTimer, 0.55);
        if (z.state !== 'CHASE') {
          z.state = 'INVESTIGATE';
          z.investigateTarget = origin.clone();
          z.investigateTimer = 9.0;
        }
      }
    }
    return kills;
  }

  public shiftOrigin(shiftX: number, shiftZ: number): void {
    this.sharedBloodPool.shiftOrigin(shiftX, shiftZ);
    for (const z of this.zombies) {
      z.group.position.x -= shiftX;
      z.group.position.z -= shiftZ;
      z.wanderTarget.x -= shiftX;
      z.wanderTarget.z -= shiftZ;
      if (z.investigateTarget) {
        z.investigateTarget.x -= shiftX;
        z.investigateTarget.z -= shiftZ;
      }
    }
  }

  public update(
    delta: number,
    nowMs: number,
    world: BuiltWorld,
    playerPos: THREE.Vector3,
    playerCrouched: boolean,
    flashlightOn: boolean,
    cameraForward: THREE.Vector3,
    onAttackPlayer: (damage: number, bleedChance: number) => void,
  ): void {
    this.lastWorldRef = world;
    const dt = Math.min(delta, 0.05);

    for (const z of this.zombies) {
      if (z.state === 'DEAD') {
        if (z.deathProgress < 1) {
          z.deathProgress = Math.min(1, z.deathProgress + dt * 3.8);
          z.group.rotation.x = -Math.PI * 0.48 * z.deathProgress;
          z.group.position.y = world.groundHeightAt(z.group.position.x, z.group.position.z) + 0.14 * z.deathProgress;
        }
        continue;
      }

      const groundY = world.groundHeightAt(z.group.position.x, z.group.position.z);
      z.trauma.update(dt, z.group.position, groundY);
      const mod = z.trauma.getModifiersReadOnly();
      z.hp = Math.round(mod.normalizedHealth);

      if (!mod.alive) {
        this.markZombieDead(z);
        continue;
      }

      if (z.attackCooldown > 0) z.attackCooldown -= dt;
      if (z.staggerTimer > 0) {
        z.staggerTimer = Math.max(0, z.staggerTimer - dt);
        if (z.staggerTimer <= 0) {
          z.staggerKind = 'none';
          z.staggerTotalSec = 0;
        }
      }

      // Smooth damped horizontal knockback from push-kicks & rifle bashes (collision-safe)
      const kbSpeedSq = z.knockbackVelX * z.knockbackVelX + z.knockbackVelZ * z.knockbackVelZ;
      if (kbSpeedSq > 0.0025) {
        this.moveZombieWithCollision(z, z.knockbackVelX * dt, z.knockbackVelZ * dt, world, false);
        const kbDecay = Math.exp(-5.4 * dt);
        z.knockbackVelX *= kbDecay;
        z.knockbackVelZ *= kbDecay;
      } else {
        z.knockbackVelX = 0;
        z.knockbackVelZ = 0;
      }

      if (this.debugEnabled) {
        const coneMat = z.debugCone.material as THREE.MeshBasicMaterial;
        coneMat.color.setHex(
          z.state === 'CHASE' || z.state === 'ATTACK'
            ? 0xef4444
            : z.state === 'INVESTIGATE'
              ? 0xf59e0b
              : 0x38bdf8,
        );
      }

      // 1. Vision Check (concussion blur impairs AI visual acuity just like player)
      const canSee = this.checkVisualDetection(
        z,
        world,
        playerPos,
        playerCrouched,
        flashlightOn,
        cameraForward,
        mod.concussionBlur,
      );
      if (canSee) {
        if (z.state !== 'CHASE' && z.state !== 'ATTACK') {
          this.audio.playZombieVocal(z.group.position, 'alert');
        }
        z.state = 'CHASE';
        z.lastSeenPlayerTimer = 4.2;
        z.investigateTarget = playerPos.clone();
      } else if (z.state === 'CHASE' || z.state === 'ATTACK') {
        z.lastSeenPlayerTimer -= dt;
        if (z.lastSeenPlayerTimer <= 0) {
          z.state = 'INVESTIGATE';
          z.investigateTimer = 6.0;
        }
      }

      // 2. Spatialized HRTF idle rasps
      if (nowMs >= z.nextVocalMs) {
        z.nextVocalMs = nowMs + (z.state === 'CHASE' ? 2200 : 5200) + Math.random() * 4500;
        if (z.group.position.distanceTo(playerPos) < 42) {
          this.audio.playZombieVocal(z.group.position, z.state === 'CHASE' ? 'alert' : 'rasp');
        }
      }

      // 3. State Movement & Behavior (with 6-limb trauma parity)
      const distToPlayer = z.group.position.distanceTo(playerPos);
      let moveSpeed = 0;
      let moveTarget: THREE.Vector3 | null = null;
      const limbs = z.trauma.getLimbStatesReadOnly();
      const leftArmBroken = limbs.leftArm.blackedOut || limbs.leftArm.fracture;
      const rightArmBroken = limbs.rightArm.blackedOut || limbs.rightArm.fracture;
      const armDamageMult =
        leftArmBroken && rightArmBroken ? 0.55 : leftArmBroken || rightArmBroken ? 0.78 : 1.0;

      if (z.staggerTimer > 0) {
        moveSpeed = 0;
      } else if (z.state === 'CHASE' || z.state === 'ATTACK') {
        if (distToPlayer <= z.archetype.attackRangeM) {
          z.state = 'ATTACK';
          moveSpeed = 0;
          this.steerTowards(z, playerPos, dt * 8);
          if (z.attackCooldown <= 0) {
            // Damaged/blacked arms slow wind-up cooldown (up to 1.6x slower via reloadSpeedMult) and reduce strike force
            z.attackCooldown = z.archetype.attackCooldownSec / Math.max(0.55, mod.reloadSpeedMult);
            this.audio.playZombieVocal(z.group.position, 'alert');
            onAttackPlayer(z.archetype.attackDamage * armDamageMult, z.archetype.bleedChance);
          }
        } else {
          z.state = 'CHASE';
          moveTarget = canSee ? playerPos : z.investigateTarget;
          // Blacked-out / fractured leg disables sprint/lunge speed
          const maxCrippledChase = z.archetype.investigateSpeedMps * 1.12;
          const baseChase = mod.canSprint
            ? z.archetype.chaseSpeedMps
            : Math.min(z.archetype.chaseSpeedMps, maxCrippledChase);
          moveSpeed = baseChase * mod.moveSpeedMult;
        }
      } else if (z.state === 'INVESTIGATE') {
        if (z.investigateTarget) {
          const d = Math.hypot(
            z.investigateTarget.x - z.group.position.x,
            z.investigateTarget.z - z.group.position.z,
          );
          if (d > 0.9) {
            moveTarget = z.investigateTarget;
            moveSpeed = z.archetype.investigateSpeedMps * mod.moveSpeedMult;
          } else {
            z.investigateTimer -= dt;
            z.yaw += Math.sin(nowMs * 0.002) * dt * 1.1;
            if (z.investigateTimer <= 0) {
              z.state = 'IDLE_WANDER';
              z.investigateTarget = null;
            }
          }
        } else {
          z.state = 'IDLE_WANDER';
        }
      } else {
        // IDLE_WANDER (local relative wander, unbounded world-space)
        const d = Math.hypot(z.wanderTarget.x - z.group.position.x, z.wanderTarget.z - z.group.position.z);
        if (d < 0.8) {
          z.wanderWaitTimer -= dt;
          if (z.wanderWaitTimer <= 0) {
            z.wanderWaitTimer = 2.0 + Math.random() * 3.5;
            const ang = Math.random() * Math.PI * 2;
            const rad = 4 + Math.random() * 9;
            z.wanderTarget.set(
              z.group.position.x + Math.cos(ang) * rad,
              0,
              z.group.position.z + Math.sin(ang) * rad,
            );
          }
        } else {
          moveTarget = z.wanderTarget;
          moveSpeed = z.archetype.wanderSpeedMps * mod.moveSpeedMult;
        }
      }

      const armTremor = mod.tremorAmp > 0 ? Math.sin(nowMs * 0.045) * mod.tremorAmp * 18 : 0;
      const baseArmPitchL = leftArmBroken ? -0.18 : -1.15;
      const baseArmPitchR = rightArmBroken ? -0.22 : -1.25;
      const armAmpL = leftArmBroken ? 0.08 : 0.25;
      const armAmpR = rightArmBroken ? 0.08 : 0.25;

      let limpDropY = 0;
      if (moveTarget && moveSpeed > 0) {
        this.steerTowards(z, moveTarget, dt * 4.8);
        const stepX = Math.sin(z.yaw) * moveSpeed * dt;
        const stepZ = Math.cos(z.yaw) * moveSpeed * dt;
        this.moveZombieWithCollision(z, stepX, stepZ, world);

        z.gaitPhase += dt * moveSpeed * 3.4 * mod.limpCadenceScale;
        const leftAmp = 0.52 * (1 - mod.leftLegImpairment * 0.58);
        const rightAmp = 0.52 * (1 - mod.rightLegImpairment * 0.58);
        const swingPhase = Math.sin(z.gaitPhase);
        z.leftLeg.rotation.x = swingPhase * leftAmp;
        z.rightLeg.rotation.x = -swingPhase * rightAmp;
        z.leftArm.rotation.x = baseArmPitchL + Math.cos(z.gaitPhase) * armAmpL + armTremor;
        z.rightArm.rotation.x = baseArmPitchR - Math.cos(z.gaitPhase) * armAmpR - armTremor;

        // Asymmetric limp lean & hip drop synced to injured side stance
        const limpStanceWeight = Math.max(0, -mod.asymmetricLimpDip * swingPhase);
        limpDropY = -limpStanceWeight * 0.095;
        z.group.rotation.z = THREE.MathUtils.damp(
          z.group.rotation.z,
          mod.asymmetricLimpDip * 0.18 * (0.6 + 0.4 * Math.abs(swingPhase)),
          10,
          dt,
        );
      } else {
        z.leftLeg.rotation.x = THREE.MathUtils.damp(z.leftLeg.rotation.x, 0, 8, dt);
        z.rightLeg.rotation.x = THREE.MathUtils.damp(z.rightLeg.rotation.x, 0, 8, dt);
        z.leftArm.rotation.x = THREE.MathUtils.damp(z.leftArm.rotation.x, baseArmPitchL + armTremor, 8, dt);
        z.rightArm.rotation.x = THREE.MathUtils.damp(z.rightArm.rotation.x, baseArmPitchR - armTremor, 8, dt);
        z.group.rotation.z = THREE.MathUtils.damp(z.group.rotation.z, mod.asymmetricLimpDip * 0.08, 8, dt);
      }

      // Expressive stagger body language: head-snap vs kick stumble recovery
      if (z.staggerTimer > 0 && z.staggerTotalSec > 0.01) {
        const remainRatio = THREE.MathUtils.clamp(z.staggerTimer / z.staggerTotalSec, 0, 1);
        const env = Math.sin(remainRatio * Math.PI * 0.85);
        if (z.staggerKind === 'head_snap') {
          z.headMesh.rotation.x = THREE.MathUtils.damp(z.headMesh.rotation.x, -0.62 * env, 24, dt);
          z.headMesh.rotation.y = THREE.MathUtils.damp(z.headMesh.rotation.y, 0.34 * env, 20, dt);
          z.torsoMesh.rotation.x = THREE.MathUtils.damp(z.torsoMesh.rotation.x, -0.18 * env, 16, dt);
          z.leftArm.rotation.x = THREE.MathUtils.damp(z.leftArm.rotation.x, baseArmPitchL - 0.32 * env, 14, dt);
          z.rightArm.rotation.x = THREE.MathUtils.damp(z.rightArm.rotation.x, baseArmPitchR - 0.32 * env, 14, dt);
        } else if (z.staggerKind === 'kick_stumble') {
          const flail = Math.sin(nowMs * 0.022) * 0.24 * env;
          z.torsoMesh.rotation.x = THREE.MathUtils.damp(z.torsoMesh.rotation.x, -0.38 * env, 18, dt);
          z.headMesh.rotation.x = THREE.MathUtils.damp(z.headMesh.rotation.x, -0.28 * env, 16, dt);
          z.leftArm.rotation.x = THREE.MathUtils.damp(z.leftArm.rotation.x, -1.78 * env + flail, 16, dt);
          z.rightArm.rotation.x = THREE.MathUtils.damp(z.rightArm.rotation.x, -1.68 * env - flail, 16, dt);
          z.leftLeg.rotation.x = THREE.MathUtils.damp(z.leftLeg.rotation.x, 0.28 * env, 14, dt);
          z.rightLeg.rotation.x = THREE.MathUtils.damp(z.rightLeg.rotation.x, -0.32 * env, 14, dt);
        } else {
          z.torsoMesh.rotation.x = THREE.MathUtils.damp(z.torsoMesh.rotation.x, -0.22 * env, 16, dt);
          z.headMesh.rotation.x = THREE.MathUtils.damp(z.headMesh.rotation.x, -0.24 * env, 16, dt);
        }
      } else {
        z.headMesh.rotation.x = THREE.MathUtils.damp(z.headMesh.rotation.x, 0, 12, dt);
        z.headMesh.rotation.y = THREE.MathUtils.damp(z.headMesh.rotation.y, 0, 12, dt);
        z.torsoMesh.rotation.x = THREE.MathUtils.damp(z.torsoMesh.rotation.x, 0, 12, dt);
      }

      z.group.position.y = groundY + limpDropY;
      z.group.rotation.y = z.yaw;
    }
  }

  private steerTowards(z: ZombieActor, target: THREE.Vector3, rate: number): void {
    const desired = Math.atan2(target.x - z.group.position.x, target.z - z.group.position.z);
    let diff = desired - z.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    z.yaw += diff * Math.min(1, rate);
  }

  private moveZombieWithCollision(
    z: ZombieActor,
    dx: number,
    dz: number,
    world: BuiltWorld,
    turnOnBlocked = true,
  ): void {
    const r = 0.36;
    const canOccupy = (x: number, pz: number): boolean => {
      for (const box of world.colliders) {
        if (!box.blocksMovement) continue;
        if (box.minY > 1.5 || box.maxY < 0.2) continue;
        const cx = THREE.MathUtils.clamp(x, box.minX, box.maxX);
        const cz = THREE.MathUtils.clamp(pz, box.minZ, box.maxZ);
        if ((x - cx) * (x - cx) + (pz - cz) * (pz - cz) < r * r) {
          return false;
        }
      }
      return true;
    };

    if (canOccupy(z.group.position.x + dx, z.group.position.z)) {
      z.group.position.x += dx;
    } else if (turnOnBlocked) {
      z.yaw += 0.65 * Math.sign(Math.sin(z.gaitPhase) || 1);
    }
    if (canOccupy(z.group.position.x, z.group.position.z + dz)) {
      z.group.position.z += dz;
    }
  }

  private checkVisualDetection(
    z: ZombieActor,
    world: BuiltWorld,
    playerPos: THREE.Vector3,
    playerCrouched: boolean,
    flashlightOn: boolean,
    cameraForward: THREE.Vector3,
    concussionBlur = 0,
  ): boolean {
    const spec = z.archetype;
    let effectiveRange = spec.visionRangeM * (1 - THREE.MathUtils.clamp(concussionBlur, 0, 1) * 0.45);

    if (playerCrouched) {
      effectiveRange *= spec.crouchVisionMult;
      if (world.isInStealthBrush(playerPos.x, playerPos.z)) {
        effectiveRange *= 0.5;
      }
    }
    if (world.isIndoor(playerPos.x, playerPos.z) && !flashlightOn) {
      effectiveRange *= 0.58;
    }

    if (flashlightOn) {
      this._dir.subVectors(z.group.position, playerPos).normalize();
      const beamAlign = cameraForward.dot(this._dir);
      if (beamAlign > 0.72) {
        effectiveRange *= spec.flashlightDetectionMult;
      } else {
        effectiveRange *= 1.45;
      }
    }

    const dist = z.group.position.distanceTo(playerPos);
    if (dist > effectiveRange) return false;

    const fwdX = Math.sin(z.yaw);
    const fwdZ = Math.cos(z.yaw);
    const toPx = (playerPos.x - z.group.position.x) / Math.max(0.001, dist);
    const toPz = (playerPos.z - z.group.position.z) / Math.max(0.001, dist);
    const dot = fwdX * toPx + fwdZ * toPz;
    const cosHalf = Math.cos(THREE.MathUtils.degToRad(spec.visionConeDeg * 0.5));
    if (dot < cosHalf && dist > 1.8) return false;

    // Raycast LoS check (solid walls/closed doors block vision; unbroken glass does NOT)
    this._origin.copy(z.group.position).setY(z.group.position.y + 1.5);
    this._target.copy(playerPos).setY(playerPos.y + (playerCrouched ? 0.85 : 1.35));
    this._dir.subVectors(this._target, this._origin);
    const len = this._dir.length();
    this._dir.divideScalar(Math.max(0.001, len));

    this.raycaster.set(this._origin, this._dir);
    this.raycaster.near = 0.25;
    this.raycaster.far = len - 0.25;
    const hits = this.raycaster.intersectObjects(world.raycastMeshes, false);
    return !hits.some((h) => !h.object.userData.isGlass);
  }

  public getDebugStats(): { totalAlive: number; investigating: number; chasing: number } {
    let totalAlive = 0;
    let investigating = 0;
    let chasing = 0;
    for (const z of this.zombies) {
      if (z.state !== 'DEAD') {
        totalAlive++;
        if (z.state === 'INVESTIGATE') investigating++;
        if (z.state === 'CHASE' || z.state === 'ATTACK') chasing++;
      }
    }
    return { totalAlive, investigating, chasing };
  }

  public exportStates(originX = 0, originZ = 0): ZombieSaveState[] {
    const out: ZombieSaveState[] = this.zombies.map((z) => ({
      id: z.id,
      archetypeId: z.archetype.id,
      position: [z.group.position.x + originX, z.group.position.y, z.group.position.z + originZ],
      yaw: z.yaw,
      hp: z.hp,
      state: z.state,
      investigateTarget: z.investigateTarget
        ? [z.investigateTarget.x + originX, z.investigateTarget.y, z.investigateTarget.z + originZ]
        : null,
      trauma: z.trauma.exportSaveState(),
    }));
    for (const archived of this.savedArchive.values()) {
      out.push({
        ...archived,
        position: [...archived.position] as [number, number, number],
        investigateTarget: archived.investigateTarget
          ? ([...archived.investigateTarget] as [number, number, number])
          : null,
        trauma: archived.trauma
          ? {
              painkillerRemainingSec: archived.trauma.painkillerRemainingSec,
              limbs: {
                head: { ...archived.trauma.limbs.head },
                thorax: { ...archived.trauma.limbs.thorax },
                leftArm: { ...archived.trauma.limbs.leftArm },
                rightArm: { ...archived.trauma.limbs.rightArm },
                leftLeg: { ...archived.trauma.limbs.leftLeg },
                rightLeg: { ...archived.trauma.limbs.rightLeg },
              },
            }
          : undefined,
      });
    }
    return out;
  }

  public clear(): void {
    for (let i = this.zombies.length - 1; i >= 0; i--) {
      this.removeZombieAt(i);
    }
    this.zombies = [];
    this.hitMeshes = [];
    this.savedArchive.clear();
    this.sharedBloodPool.clearDecals();
  }

  public dispose(): void {
    this.unsubscribeAcoustic?.();
    this.clear();
    this.sharedBloodPool.dispose();
  }
}

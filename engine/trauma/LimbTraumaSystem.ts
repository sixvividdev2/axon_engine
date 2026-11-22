import * as THREE from 'three';
import {
  createDefaultLimbStates,
  createNeutralTraumaModifiers,
  LIMB_CONFIGS,
  LIMB_IDS,
  LimbId,
  LimbState,
  TOTAL_LIMB_MAX_HP,
  TRAUMA_LIMITS,
  TRAUMA_RATE_CONSTANTS,
  TraumaModifiers,
  TraumaSaveState,
} from '../../data/traumaConfig';

export type TraumaDamageKind = 'bullet' | 'slash' | 'blunt' | 'blast' | 'fall';

export interface TraumaHitResult {
  limbId: LimbId;
  damageApplied: number;
  overflowDistributed: number;
  triggeredLightBleed: boolean;
  triggeredHeavyBleed: boolean;
  triggeredFracture: boolean;
  fatal: boolean;
}

export interface MedicalApplyResult {
  applied: boolean;
  curedCondition: string;
  targetLimbId?: LimbId;
}

const MAX_BLOOD_DECALS = 32;

function createBloodDecalTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);

  // Irregular organic arterial blood splatter
  for (let i = 0; i < 14; i++) {
    const angle = (i / 14) * Math.PI * 2 + (i % 3) * 0.25;
    const dist = i === 0 ? 0 : 4 + ((i * 19) % 16);
    const r = i === 0 ? 15 : 4 + ((i * 7) % 8);
    const cx = size * 0.5 + Math.cos(angle) * dist;
    const cy = size * 0.5 + Math.sin(angle) * dist;

    const grad = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r);
    grad.addColorStop(0, 'rgba(62, 6, 8, 0.92)');
    grad.addColorStop(0.65, 'rgba(84, 10, 10, 0.68)');
    grad.addColorStop(1, 'rgba(45, 5, 5, 0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class LimbTraumaSystem {
  private readonly limbs: Record<LimbId, LimbState> = createDefaultLimbStates();
  private readonly modifiers: TraumaModifiers = createNeutralTraumaModifiers();

  private bleedDecalTimer = 0;
  private bleedHpAccumulator = 0;
  private painkillerRemainingSec = 0;
  private maxHpScale = 1.0;
  private onBloodDecal: ((x: number, y: number, z: number, scale: number) => void) | null = null;

  // Pooled blood decal ring buffer (zero runtime allocations during bleed ticks)
  private scene: THREE.Scene | null = null;
  private decalGeo: THREE.CircleGeometry | null = null;
  private decalMat: THREE.MeshStandardMaterial | null = null;
  private decalTex: THREE.CanvasTexture | null = null;
  private decalPool: THREE.Mesh[] = [];
  private decalCursor = 0;

  // Pre-allocated scratch containers for zero-GC updates
  private readonly _aliveNonZeroIds: LimbId[] = [];
  private readonly _lastHitResult: TraumaHitResult = {
    limbId: 'thorax',
    damageApplied: 0,
    overflowDistributed: 0,
    triggeredLightBleed: false,
    triggeredHeavyBleed: false,
    triggeredFracture: false,
    fatal: false,
  };

  constructor(
    scene?: THREE.Scene,
    maxHpScale = 1.0,
    onBloodDecal?: (x: number, y: number, z: number, scale: number) => void,
  ) {
    this.maxHpScale = Math.max(0.2, maxHpScale);
    this.onBloodDecal = onBloodDecal ?? null;
    if (scene) {
      this.attachScene(scene);
    }
    this.reset(this.maxHpScale);
  }

  public setBloodDecalHandler(handler: ((x: number, y: number, z: number, scale: number) => void) | null): void {
    this.onBloodDecal = handler;
  }

  public attachScene(scene: THREE.Scene): void {
    if (this.scene === scene) return;
    this.disposeDecals();
    this.scene = scene;
    this.decalTex = createBloodDecalTexture();
    this.decalGeo = new THREE.CircleGeometry(0.18, 12);
    this.decalGeo.rotateX(-Math.PI * 0.5);
    this.decalMat = new THREE.MeshStandardMaterial({
      map: this.decalTex,
      transparent: true,
      opacity: 0.85,
      roughness: 0.35,
      metalness: 0.05,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });

    for (let i = 0; i < MAX_BLOOD_DECALS; i++) {
      const m = new THREE.Mesh(this.decalGeo, this.decalMat);
      m.visible = false;
      m.receiveShadow = true;
      scene.add(m);
      this.decalPool.push(m);
    }
    this.decalCursor = 0;
  }

  public reset(maxHpScale?: number): void {
    if (maxHpScale !== undefined) {
      this.maxHpScale = Math.max(0.2, maxHpScale);
    }
    for (let i = 0; i < LIMB_IDS.length; i++) {
      const id = LIMB_IDS[i];
      const cfg = LIMB_CONFIGS[id];
      const l = this.limbs[id];
      const scaledMax = Math.round(cfg.maxHp * this.maxHpScale);
      l.hp = scaledMax;
      l.maxHp = scaledMax;
      l.vital = cfg.vital;
      l.lightBleed = false;
      l.heavyBleed = false;
      l.fracture = false;
      l.blackedOut = false;
    }
    this.painkillerRemainingSec = 0;
    this.bleedDecalTimer = 0;
    this.bleedHpAccumulator = 0;
    this.modifiers.tinnitusLevel = 0;
    this.modifiers.muffleLevel = 0;
    this.modifiers.concussionBlur = 0;
    this.modifiers.chromaticSpike = 0;
    this.modifiers.pendingFlinchPitch = 0;
    this.modifiers.pendingFlinchYaw = 0;
    this.clearDecals();
    this.recomputeModifiers();
  }

  public clearDecals(): void {
    for (let i = 0; i < this.decalPool.length; i++) {
      this.decalPool[i].visible = false;
    }
    this.decalCursor = 0;
  }

  public shiftOrigin(shiftX: number, shiftZ: number): void {
    for (let i = 0; i < this.decalPool.length; i++) {
      const m = this.decalPool[i];
      if (!m.visible) continue;
      m.position.x -= shiftX;
      m.position.z -= shiftZ;
    }
  }

  public getLimbStatesReadOnly(): Readonly<Record<LimbId, Readonly<LimbState>>> {
    return this.limbs;
  }

  public getModifiersReadOnly(): Readonly<TraumaModifiers> {
    return this.modifiers;
  }

  public consumeFlinch(out: { pitch: number; yaw: number }): boolean {
    const p = this.modifiers.pendingFlinchPitch;
    const y = this.modifiers.pendingFlinchYaw;
    if (Math.abs(p) < 1e-5 && Math.abs(y) < 1e-5) {
      out.pitch = 0;
      out.yaw = 0;
      return false;
    }
    out.pitch = p;
    out.yaw = y;
    this.modifiers.pendingFlinchPitch = 0;
    this.modifiers.pendingFlinchYaw = 0;
    return true;
  }

  /**
   * Core damage application with non-vital limb blackout + overflow propagation.
   */
  public applyDamageToLimb(
    limbId: LimbId,
    rawDamage: number,
    damageKind: TraumaDamageKind,
    energyJ: number,
    bleedChanceOverride?: number,
    groundPos?: THREE.Vector3,
    groundY?: number,
  ): Readonly<TraumaHitResult> {
    const res = this._lastHitResult;
    res.limbId = limbId;
    res.damageApplied = 0;
    res.overflowDistributed = 0;
    res.triggeredLightBleed = false;
    res.triggeredHeavyBleed = false;
    res.triggeredFracture = false;
    res.fatal = false;

    if (!this.modifiers.alive || rawDamage <= 0) return res;

    const cfg = LIMB_CONFIGS[limbId];
    const target = this.limbs[limbId];
    const prevHp = target.hp;

    if (prevHp > 0) {
      const direct = Math.min(prevHp, rawDamage);
      target.hp = Math.max(0, prevHp - direct);
      res.damageApplied = direct;

      const excess = rawDamage - direct;
      if (target.hp <= 0 && !cfg.vital) {
        target.blackedOut = true;
      }
      if (excess > 0 && !cfg.vital && cfg.overflowMult > 0) {
        res.overflowDistributed = this.distributeOverflow(limbId, excess * cfg.overflowMult);
      }
    } else if (!cfg.vital && cfg.overflowMult > 0) {
      // Hitting an already blacked-out limb spreads overflow directly
      res.overflowDistributed = this.distributeOverflow(limbId, rawDamage * cfg.overflowMult);
    }

    // Condition triggers (bleed & fracture)
    const energyRatio = energyJ / Math.max(1, cfg.heavyBleedThresholdJ);
    const defaultBleedProb =
      damageKind === 'slash'
        ? 0.58
        : damageKind === 'bullet'
          ? THREE.MathUtils.clamp(0.28 + energyRatio * 0.25, 0.25, 0.88)
          : damageKind === 'blast'
            ? 0.65
            : damageKind === 'fall'
              ? 0.14
              : 0.12;
    const bleedProb = bleedChanceOverride !== undefined ? bleedChanceOverride : defaultBleedProb;

    if (Math.random() < bleedProb && (rawDamage >= 6 || damageKind === 'slash' || damageKind === 'bullet')) {
      const heavyRoll =
        damageKind === 'bullet'
          ? energyJ >= cfg.heavyBleedThresholdJ && Math.random() < 0.65
          : damageKind === 'slash'
            ? rawDamage >= 16 && Math.random() < 0.45
            : damageKind === 'blast'
              ? rawDamage >= 20 && Math.random() < 0.55
              : false;
      if (heavyRoll) {
        if (!target.heavyBleed) {
          target.heavyBleed = true;
          target.lightBleed = false;
          res.triggeredHeavyBleed = true;
        }
      } else if (!target.heavyBleed && !target.lightBleed) {
        target.lightBleed = true;
        res.triggeredLightBleed = true;
      }
    }

    if (
      !cfg.vital &&
      !target.fracture &&
      (damageKind === 'blunt' || damageKind === 'bullet' || damageKind === 'blast' || damageKind === 'fall')
    ) {
      const fracThresh =
        damageKind === 'blunt' ? cfg.fractureThresholdJ * 0.55 : cfg.fractureThresholdJ;
      if (energyJ >= fracThresh && Math.random() < (damageKind === 'fall' ? 0.72 : 0.48)) {
        target.fracture = true;
        res.triggeredFracture = true;
      }
    }

    // Concussion on head hits & blasts
    if (limbId === 'head') {
      const severity = THREE.MathUtils.clamp(rawDamage / 24, 0.35, 1.0);
      this.triggerHeadConcussion(severity);
    } else if (damageKind === 'blast' && rawDamage > 12) {
      this.triggerHeadConcussion(THREE.MathUtils.clamp(rawDamage / 55, 0.25, 0.85));
    }

    // Directional aim flinch (never drops weapon)
    const flinchScale =
      limbId === 'rightArm'
        ? 1.0
        : limbId === 'leftArm'
          ? 0.78
          : limbId === 'head'
            ? 1.15
            : 0.48;
    if (rawDamage >= 7 || target.blackedOut) {
      const amp = THREE.MathUtils.clamp((rawDamage / 28) * flinchScale, 0.015, 0.14);
      const yawDir = limbId === 'leftArm' ? -1 : limbId === 'rightArm' ? 1 : Math.random() < 0.5 ? -1 : 1;
      this.modifiers.pendingFlinchPitch += amp * (0.65 + Math.random() * 0.45);
      this.modifiers.pendingFlinchYaw += yawDir * amp * (0.55 + Math.random() * 0.5);
    }

    if (groundPos && groundY !== undefined && rawDamage >= 9) {
      this.spawnBloodDecal(groundPos.x, groundY, groundPos.z, target.heavyBleed ? 1.15 : 0.8);
    }

    this.recomputeModifiers();
    res.fatal = !this.modifiers.alive;
    return res;
  }

  private distributeOverflow(sourceLimbId: LimbId, overflowDamage: number): number {
    if (overflowDamage <= 0) return 0;
    this._aliveNonZeroIds.length = 0;
    for (let i = 0; i < LIMB_IDS.length; i++) {
      const id = LIMB_IDS[i];
      if (id !== sourceLimbId && this.limbs[id].hp > 0) {
        this._aliveNonZeroIds.push(id);
      }
    }
    const count = this._aliveNonZeroIds.length;
    if (count === 0) return 0;

    const perLimb = overflowDamage / count;
    let totalApplied = 0;
    for (let i = 0; i < count; i++) {
      const id = this._aliveNonZeroIds[i];
      const l = this.limbs[id];
      const d = Math.min(l.hp, perLimb);
      l.hp = Math.max(0, l.hp - d);
      totalApplied += d;
      if (l.hp <= 0 && !LIMB_CONFIGS[id].vital) {
        l.blackedOut = true;
      }
    }
    return totalApplied;
  }

  public triggerHeadConcussion(severity: number): void {
    const s = THREE.MathUtils.clamp(severity, 0.15, 1.0);
    this.modifiers.tinnitusLevel = Math.max(this.modifiers.tinnitusLevel, s);
    this.modifiers.muffleLevel = Math.max(this.modifiers.muffleLevel, s * 0.95);
    this.modifiers.concussionBlur = Math.max(
      this.modifiers.concussionBlur,
      s * TRAUMA_LIMITS.maxConcussionBlur,
    );
    this.modifiers.chromaticSpike = Math.max(
      this.modifiers.chromaticSpike,
      s * TRAUMA_LIMITS.maxChromaticSpike,
    );
  }

  public applyZombieAttack(
    baseDamage: number,
    bleedChance: number,
    playerPos: THREE.Vector3,
    groundY: number,
  ): Readonly<TraumaHitResult> {
    // Weighted anatomical strike zones from frontal/flank zombie clawing
    const roll = Math.random();
    let zone: LimbId = 'thorax';
    if (roll < 0.24) zone = 'leftArm';
    else if (roll < 0.48) zone = 'rightArm';
    else if (roll < 0.72) zone = 'thorax';
    else if (roll < 0.84) zone = 'leftLeg';
    else if (roll < 0.96) zone = 'rightLeg';
    else zone = 'head';

    const energy = baseDamage * 11;
    return this.applyDamageToLimb(zone, baseDamage, 'slash', energy, bleedChance, playerPos, groundY);
  }

  public applySelfHit(
    limbId: LimbId,
    damageKind: 'bullet' | 'slash' | 'blunt',
    energyJ: number,
    impactPos: THREE.Vector3,
    groundY: number,
  ): Readonly<TraumaHitResult> {
    const rawDamage =
      damageKind === 'bullet'
        ? THREE.MathUtils.clamp(energyJ / 22, 12, 48)
        : damageKind === 'slash'
          ? THREE.MathUtils.clamp(energyJ / 9.5, 10, 28)
          : THREE.MathUtils.clamp(energyJ / 12, 8, 24);

    return this.applyDamageToLimb(limbId, rawDamage, damageKind, energyJ, undefined, impactPos, groundY);
  }

  public applyBlastDamage(
    baseDamage: number,
    bleedChance: number,
    playerPos: THREE.Vector3,
    groundY: number,
  ): boolean {
    if (!this.modifiers.alive) return false;
    // Shrapnel hits thorax, arms, legs, and possible concussive head hit
    this.applyDamageToLimb('thorax', baseDamage * 0.45, 'blast', baseDamage * 9, bleedChance, playerPos, groundY);
    if (!this.modifiers.alive) return true;
    this.applyDamageToLimb('leftArm', baseDamage * 0.28, 'blast', baseDamage * 7, bleedChance * 0.8);
    this.applyDamageToLimb('rightArm', baseDamage * 0.28, 'blast', baseDamage * 7, bleedChance * 0.8);
    this.applyDamageToLimb('leftLeg', baseDamage * 0.34, 'blast', baseDamage * 8, bleedChance * 0.9);
    this.applyDamageToLimb('rightLeg', baseDamage * 0.34, 'blast', baseDamage * 8, bleedChance * 0.9);
    if (baseDamage > 22) {
      this.applyDamageToLimb('head', baseDamage * 0.20, 'blast', baseDamage * 5, bleedChance * 0.45);
    }
    return !this.modifiers.alive;
  }

  public applyFallImpact(dropMeters: number, playerPos: THREE.Vector3, groundY: number): boolean {
    const legInjured =
      this.limbs.leftLeg.fracture ||
      this.limbs.rightLeg.fracture ||
      this.limbs.leftLeg.blackedOut ||
      this.limbs.rightLeg.blackedOut ||
      this.limbs.leftLeg.hp < this.limbs.leftLeg.maxHp * 0.6 ||
      this.limbs.rightLeg.hp < this.limbs.rightLeg.maxHp * 0.6;

    const threshold = legInjured ? 1.05 : 1.75;
    if (dropMeters < threshold) return false;

    const excess = dropMeters - threshold;
    const totalLegDmg = THREE.MathUtils.clamp(excess * (legInjured ? 28 : 19), 6, 75);
    const fallEnergyJ = excess * (legInjured ? 380 : 280);

    this.applyDamageToLimb(
      'leftLeg',
      totalLegDmg * (0.45 + Math.random() * 0.15),
      'fall',
      fallEnergyJ,
      legInjured ? 0.32 : 0.12,
      playerPos,
      groundY,
    );
    if (this.modifiers.alive) {
      this.applyDamageToLimb(
        'rightLeg',
        totalLegDmg * (0.45 + Math.random() * 0.15),
        'fall',
        fallEnergyJ,
        legInjured ? 0.32 : 0.12,
      );
    }
    return true;
  }

  public applyMedicalItem(itemId: string, preferredLimb?: LimbId): MedicalApplyResult {
    if (!this.modifiers.alive) {
      return { applied: false, curedCondition: '' };
    }

    if (itemId === 'painkillers') {
      this.painkillerRemainingSec = TRAUMA_RATE_CONSTANTS.painkillerDurationSec;
      this.recomputeModifiers();
      return { applied: true, curedCondition: 'Pain suppressed (90s)' };
    }

    if (itemId === 'tourniquet') {
      const target = this.pickLimbByPredicate(
        preferredLimb,
        (l) => l.heavyBleed,
        (a, b) => (LIMB_CONFIGS[b].vital ? 1 : 0) - (LIMB_CONFIGS[a].vital ? 1 : 0) || a.localeCompare(b),
      );
      if (!target) {
        return { applied: false, curedCondition: 'No heavy bleed' };
      }
      this.limbs[target].heavyBleed = false;
      this.recomputeModifiers();
      return {
        applied: true,
        curedCondition: `${LIMB_CONFIGS[target].label} heavy bleed stopped`,
        targetLimbId: target,
      };
    }

    if (itemId === 'bandage') {
      const target = this.pickLimbByPredicate(
        preferredLimb,
        (l) => l.lightBleed,
        (a, b) => (LIMB_CONFIGS[b].vital ? 1 : 0) - (LIMB_CONFIGS[a].vital ? 1 : 0),
      );
      if (target) {
        this.limbs[target].lightBleed = false;
        if (this.limbs[target].hp > 0) {
          this.limbs[target].hp = Math.min(this.limbs[target].maxHp, this.limbs[target].hp + 8);
        }
        this.recomputeModifiers();
        return {
          applied: true,
          curedCondition: `${LIMB_CONFIGS[target].label} bleed bandaged`,
          targetLimbId: target,
        };
      }
      return { applied: false, curedCondition: 'No light bleed' };
    }

    if (itemId === 'splint') {
      const target = this.pickLimbByPredicate(
        preferredLimb,
        (l) => l.fracture,
        (a, b) => {
          const legBiasA = a === 'leftLeg' || a === 'rightLeg' ? 1 : 0;
          const legBiasB = b === 'leftLeg' || b === 'rightLeg' ? 1 : 0;
          return legBiasB - legBiasA;
        },
      );
      if (!target) {
        return { applied: false, curedCondition: 'No fracture' };
      }
      this.limbs[target].fracture = false;
      this.recomputeModifiers();
      return {
        applied: true,
        curedCondition: `${LIMB_CONFIGS[target].label} splinted`,
        targetLimbId: target,
      };
    }

    if (itemId === 'medkit') {
      let healedAny = false;
      let healedTarget: LimbId | undefined;
      let budget = 55;

      const tryHeal = (id: LimbId): void => {
        if (budget <= 0) return;
        const l = this.limbs[id];
        if (l.blackedOut || l.hp <= 0 || l.hp >= l.maxHp) return;
        const need = l.maxHp - l.hp;
        const add = Math.min(need, budget);
        l.hp += add;
        budget -= add;
        healedAny = true;
        if (!healedTarget) healedTarget = id;
      };

      if (preferredLimb) {
        tryHeal(preferredLimb);
      }

      // Prioritize vital limbs, then remaining damaged non-blacked limbs by lowest ratio
      const order: LimbId[] = ['thorax', 'head', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];
      order.sort((a, b) => {
        const va = LIMB_CONFIGS[a].vital ? 0 : 1;
        const vb = LIMB_CONFIGS[b].vital ? 0 : 1;
        if (va !== vb) return va - vb;
        return this.limbs[a].hp / this.limbs[a].maxHp - this.limbs[b].hp / this.limbs[b].maxHp;
      });

      for (let i = 0; i < order.length; i++) {
        tryHeal(order[i]);
      }

      if (!healedAny) {
        return { applied: false, curedCondition: 'No repairable limb damage' };
      }
      this.recomputeModifiers();
      return {
        applied: true,
        curedCondition: healedTarget ? `${LIMB_CONFIGS[healedTarget].label} dressed` : 'Trauma dressed',
        targetLimbId: healedTarget,
      };
    }

    return { applied: false, curedCondition: '' };
  }

  private pickLimbByPredicate(
    preferred: LimbId | undefined,
    predicate: (l: LimbState) => boolean,
    comparator?: (a: LimbId, b: LimbId) => number,
  ): LimbId | null {
    if (preferred && predicate(this.limbs[preferred])) {
      return preferred;
    }
    let best: LimbId | null = null;
    for (let i = 0; i < LIMB_IDS.length; i++) {
      const id = LIMB_IDS[i];
      if (!predicate(this.limbs[id])) continue;
      if (!best || (comparator && comparator(id, best) < 0)) {
        best = id;
      }
    }
    return best;
  }

  public getSuggestedQuickHealItem(slot: 1 | 2, inventoryItemIds: string[]): string | null {
    const has = (id: string) => inventoryItemIds.includes(id);
    if (slot === 1) {
      // [5] Bleed control -> Tourniquet for heavy bleed, Bandage for light bleed, fallback Medkit
      if (this.modifiers.anyHeavyBleed && has('tourniquet')) return 'tourniquet';
      if (this.modifiers.anyLightBleed && has('bandage')) return 'bandage';
      if (this.modifiers.anyHeavyBleed && has('bandage')) return 'bandage';
      if (this.modifiers.normalizedHealth < 99 && has('medkit')) return 'medkit';
      return null;
    }
    // [6] Stabilization -> Splint for fracture, Medkit for HP, Painkillers if impaired
    if (this.modifiers.anyFracture && has('splint')) return 'splint';
    if (this.modifiers.normalizedHealth < 92 && has('medkit')) return 'medkit';
    if (
      (this.modifiers.anyFracture ||
        this.modifiers.leftLegImpairment > 0.2 ||
        this.modifiers.rightLegImpairment > 0.2 ||
        this.modifiers.tremorAmp > 0.0004) &&
      has('painkillers')
    ) {
      return 'painkillers';
    }
    if (this.modifiers.normalizedHealth < 99 && has('medkit')) return 'medkit';
    return null;
  }

  public update(delta: number, playerPos: THREE.Vector3, groundY: number): void {
    const dt = Math.min(Math.max(delta, 0), 0.1);
    if (!this.modifiers.alive) return;

    if (this.painkillerRemainingSec > 0) {
      this.painkillerRemainingSec = Math.max(0, this.painkillerRemainingSec - dt);
    }

    // Decay concussion sensory effects
    this.modifiers.tinnitusLevel = Math.max(
      0,
      this.modifiers.tinnitusLevel - TRAUMA_RATE_CONSTANTS.tinnitusDecayPerSec * dt,
    );
    this.modifiers.muffleLevel = Math.max(
      0,
      this.modifiers.muffleLevel - TRAUMA_RATE_CONSTANTS.muffleDecayPerSec * dt,
    );
    this.modifiers.concussionBlur = Math.max(
      0,
      this.modifiers.concussionBlur - TRAUMA_RATE_CONSTANTS.blurDecayPerSec * dt,
    );
    this.modifiers.chromaticSpike = Math.max(
      0,
      this.modifiers.chromaticSpike - TRAUMA_RATE_CONSTANTS.chromaticDecayPerSec * dt * 0.015,
    );

    // Bleed ticks & ground blood decals
    let totalBleedRate = 0;
    let hasHeavy = false;
    let hasLight = false;

    for (let i = 0; i < LIMB_IDS.length; i++) {
      const id = LIMB_IDS[i];
      const l = this.limbs[id];
      let rate = 0;
      if (l.heavyBleed) {
        rate = TRAUMA_RATE_CONSTANTS.heavyBleedHpPerSec;
        hasHeavy = true;
      } else if (l.lightBleed) {
        rate = TRAUMA_RATE_CONSTANTS.lightBleedHpPerSec;
        hasLight = true;
      }
      if (rate > 0) {
        if (l.hp > 0) {
          l.hp = Math.max(0, l.hp - rate * dt);
          if (l.hp <= 0 && !l.vital) {
            l.blackedOut = true;
          }
        } else {
          // Blacked-out bleeding limb drains systemic blood from thorax
          const systemic = rate * TRAUMA_RATE_CONSTANTS.blackedSystemicBleedScale * dt;
          this.limbs.thorax.hp = Math.max(0, this.limbs.thorax.hp - systemic);
        }
        totalBleedRate += rate;
      }
    }

    if (hasHeavy || hasLight) {
      this.bleedDecalTimer += dt;
      const interval = hasHeavy
        ? TRAUMA_RATE_CONSTANTS.heavyBleedDecalIntervalSec
        : TRAUMA_RATE_CONSTANTS.lightBleedDecalIntervalSec;
      if (this.bleedDecalTimer >= interval) {
        this.bleedDecalTimer = 0;
        this.spawnBloodDecal(
          playerPos.x + (Math.random() - 0.5) * 0.24,
          groundY,
          playerPos.z + (Math.random() - 0.5) * 0.24,
          hasHeavy ? 1.1 : 0.72,
        );
      }
      this.bleedHpAccumulator += totalBleedRate * dt;
    } else {
      this.bleedDecalTimer = 0;
    }

    this.recomputeModifiers();
  }

  public spawnBloodDecal(x: number, y: number, z: number, scale: number): void {
    if (this.onBloodDecal) {
      this.onBloodDecal(x, y, z, scale);
      return;
    }
    if (this.decalPool.length === 0) return;
    const m = this.decalPool[this.decalCursor];
    this.decalCursor = (this.decalCursor + 1) % MAX_BLOOD_DECALS;
    m.position.set(x, y + 0.014, z);
    m.rotation.y = Math.random() * Math.PI * 2;
    m.scale.setScalar(scale * (0.8 + Math.random() * 0.45));
    m.visible = true;
  }

  private computeLimbSeverity(l: LimbState): number {
    const missingFrac = 1 - THREE.MathUtils.clamp(l.hp / Math.max(1, l.maxHp), 0, 1);
    let sev = missingFrac * 0.72;
    if (l.fracture) sev += 0.42;
    if (l.blackedOut) sev += 0.50;
    return THREE.MathUtils.clamp(sev, 0, 1);
  }

  public recomputeModifiers(): void {
    const mod = this.modifiers;
    const head = this.limbs.head;
    const thorax = this.limbs.thorax;
    const armL = this.limbs.leftArm;
    const armR = this.limbs.rightArm;
    const legL = this.limbs.leftLeg;
    const legR = this.limbs.rightLeg;

    const alive = head.hp > 0 && thorax.hp > 0;
    mod.alive = alive;

    let hpSum = 0;
    let maxHpSum = 0;
    let anyLight = false;
    let anyHeavy = false;
    let anyFrac = false;
    for (let i = 0; i < LIMB_IDS.length; i++) {
      const l = this.limbs[LIMB_IDS[i]];
      hpSum += l.hp;
      maxHpSum += l.maxHp;
      if (l.lightBleed) anyLight = true;
      if (l.heavyBleed) anyHeavy = true;
      if (l.fracture) anyFrac = true;
    }

    mod.anyLightBleed = anyLight;
    mod.anyHeavyBleed = anyHeavy;
    mod.anyFracture = anyFrac;
    mod.painkillerRemainingSec = this.painkillerRemainingSec;
    mod.normalizedHealth = alive ? (hpSum / Math.max(1, maxHpSum || TOTAL_LIMB_MAX_HP)) * 100 : 0;

    const pkSuppress = this.painkillerRemainingSec > 0 ? 0.22 : 1.0;

    // --- Leg Trauma & Asymmetric Limp ---
    const rawLegL = this.computeLimbSeverity(legL);
    const rawLegR = this.computeLimbSeverity(legR);
    mod.leftLegImpairment = THREE.MathUtils.clamp(rawLegL * pkSuppress, 0, 1);
    mod.rightLegImpairment = THREE.MathUtils.clamp(rawLegR * pkSuppress, 0, 1);

    const combinedLeg = Math.max(mod.leftLegImpairment, mod.rightLegImpairment) * 0.65 +
      (mod.leftLegImpairment + mod.rightLegImpairment) * 0.35;

    mod.canSprint = !(legL.blackedOut || legL.fracture || legR.blackedOut || legR.fracture);
    mod.moveSpeedMult = THREE.MathUtils.clamp(
      1.0 - combinedLeg * (1.0 - TRAUMA_LIMITS.minMoveSpeedMult),
      TRAUMA_LIMITS.minMoveSpeedMult,
      1.0,
    );
    mod.moveAccelMult = THREE.MathUtils.clamp(
      1.0 - combinedLeg * (1.0 - TRAUMA_LIMITS.minMoveAccelMult),
      TRAUMA_LIMITS.minMoveAccelMult,
      1.0,
    );
    mod.limpCadenceScale = THREE.MathUtils.clamp(
      1.0 - combinedLeg * (1.0 - TRAUMA_LIMITS.minLimpCadenceScale),
      TRAUMA_LIMITS.minLimpCadenceScale,
      1.0,
    );
    mod.asymmetricLimpDip = THREE.MathUtils.clamp(
      mod.rightLegImpairment - mod.leftLegImpairment,
      -TRAUMA_LIMITS.maxLimpDip,
      TRAUMA_LIMITS.maxLimpDip,
    );

    // --- Arm Trauma (rightArm heavier aim/recoil penalty, both degrade reload/ADS/tremor) ---
    const rawArmL = this.computeLimbSeverity(armL);
    const rawArmR = this.computeLimbSeverity(armR);
    const armCombined = THREE.MathUtils.clamp((rawArmR * 0.62 + rawArmL * 0.38) * pkSuppress, 0, 1);
    const armPhysical = THREE.MathUtils.clamp(rawArmR * 0.58 + rawArmL * 0.42, 0, 1);

    mod.swayAmpMult = THREE.MathUtils.clamp(
      1.0 + armCombined * (TRAUMA_LIMITS.maxSwayAmpMult - 1.0),
      1.0,
      TRAUMA_LIMITS.maxSwayAmpMult,
    );
    mod.tremorAmp = THREE.MathUtils.clamp(
      armCombined * TRAUMA_LIMITS.maxTremorRad,
      0,
      TRAUMA_LIMITS.maxTremorRad,
    );
    mod.adsSpeedMult = THREE.MathUtils.clamp(
      1.0 - armCombined * (1.0 - TRAUMA_LIMITS.minAdsSpeedMult),
      TRAUMA_LIMITS.minAdsSpeedMult,
      1.0,
    );
    mod.recoilMult = THREE.MathUtils.clamp(
      1.0 + (rawArmR * 0.72 + rawArmL * 0.28) * pkSuppress * (TRAUMA_LIMITS.maxRecoilMult - 1.0),
      1.0,
      TRAUMA_LIMITS.maxRecoilMult,
    );
    // Up to 1.6x slower reload (reloadSpeedMult = 0.625) when arms are blacked out
    mod.reloadSpeedMult = THREE.MathUtils.clamp(
      1.0 - armPhysical * (1.0 - TRAUMA_LIMITS.minReloadSpeedMult),
      TRAUMA_LIMITS.minReloadSpeedMult,
      1.0,
    );

    // --- Thorax & Head Vital Trauma ---
    const thoraxFrac = THREE.MathUtils.clamp(thorax.hp / thorax.maxHp, 0, 1);
    const headFrac = THREE.MathUtils.clamp(head.hp / head.maxHp, 0, 1);
    const vitalLow = 1.0 - Math.min(thoraxFrac, headFrac * 0.92 + 0.08);
    const overallLow = 1.0 - THREE.MathUtils.clamp(mod.normalizedHealth / 100, 0, 1);

    mod.staminaCap = THREE.MathUtils.clamp(
      TRAUMA_LIMITS.minStaminaCap + thoraxFrac * (1.0 - TRAUMA_LIMITS.minStaminaCap),
      TRAUMA_LIMITS.minStaminaCap,
      1.0,
    );
    mod.raggedBreathSeverity = THREE.MathUtils.clamp(
      (1 - thoraxFrac) * 0.95 + (anyHeavy ? 0.35 : 0),
      0,
      1,
    );
    mod.heartbeatSeverity = THREE.MathUtils.clamp(
      Math.max(overallLow * 1.1, anyHeavy ? 0.85 : anyLight ? 0.45 : 0, vitalLow),
      0,
      1,
    );

    mod.desaturation = THREE.MathUtils.clamp(
      Math.max(overallLow * 0.62, vitalLow * 0.68),
      0,
      TRAUMA_LIMITS.maxDesaturation,
    );
    mod.arterialVignette = THREE.MathUtils.clamp(
      Math.max(overallLow * 0.85, (anyHeavy ? 0.72 : anyLight ? 0.36 : 0), (1 - thoraxFrac) * 0.8),
      0,
      TRAUMA_LIMITS.maxArterialVignette,
    );
  }

  public exportSaveState(): TraumaSaveState {
    const limbsCopy = createDefaultLimbStates();
    for (let i = 0; i < LIMB_IDS.length; i++) {
      const id = LIMB_IDS[i];
      limbsCopy[id] = { ...this.limbs[id] };
    }
    return {
      limbs: limbsCopy,
      painkillerRemainingSec: this.painkillerRemainingSec,
    };
  }

  public loadSaveState(save: TraumaSaveState | undefined, legacyHealth = 100, legacyBleeding = false): void {
    this.reset(this.maxHpScale);
    if (save && save.limbs) {
      for (let i = 0; i < LIMB_IDS.length; i++) {
        const id = LIMB_IDS[i];
        const src = save.limbs[id];
        if (src) {
          const cfg = LIMB_CONFIGS[id];
          const l = this.limbs[id];
          l.maxHp = Math.round(cfg.maxHp * this.maxHpScale);
          l.hp = THREE.MathUtils.clamp(src.hp, 0, l.maxHp);
          l.vital = cfg.vital;
          l.lightBleed = Boolean(src.lightBleed);
          l.heavyBleed = Boolean(src.heavyBleed);
          l.fracture = Boolean(src.fracture);
          l.blackedOut = !cfg.vital && l.hp <= 0;
        }
      }
      this.painkillerRemainingSec = Math.max(0, save.painkillerRemainingSec || 0);
    } else {
      // Backwards-compatible fallback for older saves without .trauma
      const scale = THREE.MathUtils.clamp(legacyHealth / 100, 0, 1);
      for (let i = 0; i < LIMB_IDS.length; i++) {
        const id = LIMB_IDS[i];
        const l = this.limbs[id];
        l.hp = Math.round(l.maxHp * scale * 10) / 10;
        l.blackedOut = !l.vital && l.hp <= 0;
      }
      if (legacyBleeding) {
        this.limbs.leftArm.lightBleed = true;
      }
    }
    this.recomputeModifiers();
  }

  private disposeDecals(): void {
    if (this.scene) {
      for (let i = 0; i < this.decalPool.length; i++) {
        this.scene.remove(this.decalPool[i]);
      }
    }
    this.decalPool = [];
    this.decalGeo?.dispose();
    this.decalMat?.dispose();
    this.decalTex?.dispose();
    this.decalGeo = null;
    this.decalMat = null;
    this.decalTex = null;
  }

  public dispose(): void {
    this.disposeDecals();
    this.scene = null;
  }
}

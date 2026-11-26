import * as THREE from 'three';

export interface HelicopterWakeEmitter {
  /** World-space position of the helicopter rotor hub */
  readonly position: THREE.Vector3;
  /** World-space linear velocity (m/s) of the helicopter */
  readonly velocity: THREE.Vector3;
  /** Rotor downwash radius in meters */
  readonly rotorRadiusM: number;
  /** Downwash push strength multiplier */
  readonly downwashStrength: number;
}

export interface WarzoneCombatEvent {
  readonly kind: 'artillery_blast' | 'aa_flak' | 'hostile_volley';
  readonly position: THREE.Vector3;
  readonly intensity01: number;
}

export interface WarzoneUpdateContext {
  /** Escort helicopter (and optional player helicopter) wake emitters that physically displace smoke clouds */
  readonly wakeEmitters?: readonly HelicopterWakeEmitter[];
  /** Optional active escort gunship muzzle flash light injection */
  readonly escortMuzzleLightPos?: THREE.Vector3 | null;
  readonly escortMuzzleIntensity?: number;
  /** Callback fired on each artillery detonation or AA airburst for audio & crew sync */
  readonly onCombatEvent?: (event: WarzoneCombatEvent) => void;
}

export interface WarzoneFrameTelemetry {
  /** Aggregate 0..1 battlefield combat intensity this frame (drives door gunner & squadmate transitions!) */
  readonly combatIntensity01: number;
  /** World-space position of the highest-priority active battlefield threat this frame */
  readonly primaryThreatPos: THREE.Vector3;
  /** Number of dynamic pooled lights currently active */
  readonly activeLightCount: number;
  /** Total rotor-wash displacement magnitude applied to smoke clouds this frame */
  readonly smokeWakeDisplacementSum: number;
}

interface PooledDynamicLight {
  readonly light: THREE.PointLight;
  active: boolean;
  priority: number;
  ageSec: number;
  maxAgeSec: number;
  peakIntensity: number;
  baseDistance: number;
}

/**
 * Zero-GC Dynamic Light Pool Manager for aerial transit warzone cinematics.
 * Allocates a strict fixed budget of non-shadow-casting PointLights once at startup
 * and dynamically assigns them by priority to artillery flashes, AA flak bursts,
 * escort gunship muzzle pulses, and flare glows.
 */
export class WarzoneLightManager {
  public readonly root = new THREE.Group();
  private readonly slots: PooledDynamicLight[] = [];

  constructor(poolSize: number) {
    this.root.name = 'WarzoneLightPool';
    for (let i = 0; i < poolSize; i++) {
      const light = new THREE.PointLight(0xff9c3b, 0, 75, 1.35);
      light.castShadow = false;
      this.root.add(light);
      this.slots.push({
        light,
        active: false,
        priority: 0,
        ageSec: 0,
        maxAgeSec: 0.5,
        peakIntensity: 0,
        baseDistance: 75,
      });
    }
  }

  /** Claims the lowest-priority or free dynamic light slot for a transient warzone flash. */
  public triggerFlash(
    pos: THREE.Vector3,
    colorHex: number,
    peakIntensity: number,
    distance: number,
    durationSec: number,
    priority: number,
  ): void {
    let chosen: PooledDynamicLight | null = null;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.active) {
        chosen = s;
        break;
      }
      if (!chosen || s.priority < chosen.priority || (s.priority === chosen.priority && s.ageSec > chosen.ageSec)) {
        chosen = s;
      }
    }
    if (!chosen) return;
    if (chosen.active && chosen.priority > priority) return;

    chosen.active = true;
    chosen.priority = priority;
    chosen.ageSec = 0;
    chosen.maxAgeSec = Math.max(0.05, durationSec);
    chosen.peakIntensity = peakIntensity;
    chosen.baseDistance = distance;
    chosen.light.color.setHex(colorHex);
    chosen.light.distance = distance;
    chosen.light.position.copy(pos);
    chosen.light.intensity = peakIntensity;
  }

  public update(dt: number): number {
    let activeCount = 0;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.active) {
        s.light.intensity = 0;
        continue;
      }
      s.ageSec += dt;
      if (s.ageSec >= s.maxAgeSec) {
        s.active = false;
        s.priority = 0;
        s.light.intensity = 0;
      } else {
        const u = s.ageSec / s.maxAgeSec;
        // Fast incandescent peak followed by warm exponential ember fade
        const env = Math.pow(1 - u, 1.85);
        s.light.intensity = s.peakIntensity * env;
        activeCount += 1;
      }
    }
    return activeCount;
  }

  public getPoolSize(): number {
    return this.slots.length;
  }
}

interface ValleyTracerSlot {
  mesh: THREE.Mesh;
  start: THREE.Vector3;
  end: THREE.Vector3;
  periodSec: number;
  offsetSec: number;
  flightSec: number;
  isHostile: boolean;
}

interface ArtillerySiteSlot {
  pos: THREE.Vector3;
  periodSec: number;
  offsetSec: number;
  lastCycle: number;
  fireball: THREE.Mesh;
  ring: THREE.Mesh;
}

interface AaFlakSlot {
  pos: THREE.Vector3;
  periodSec: number;
  offsetSec: number;
  lastCycle: number;
  flashMesh: THREE.Mesh;
  puffMesh: THREE.Mesh;
}

interface DynamicSmokeCloudSlot {
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  origin: THREE.Vector3;
  ageSec: number;
  lifeSec: number;
  baseScale: number;
  maxScale: number;
  swirlSeed: number;
  active: boolean;
}

interface BlastEmberSlot {
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  ageSec: number;
  maxAgeSec: number;
  active: boolean;
}

interface BurningWreckSlot {
  fireMesh: THREE.Mesh;
  basePos: THREE.Vector3;
  phaseOffset: number;
}

interface SearchlightSlot {
  pivot: THREE.Group;
  baseYaw: number;
  speed: number;
  phase: number;
}

interface FlareSlot {
  mesh: THREE.Mesh;
  x: number;
  z: number;
  phaseOffset: number;
}

export interface CinematicWarzoneVfx {
  readonly root: THREE.Group;
  readonly lightManager: WarzoneLightManager;
  /**
   * Steps all particles, dynamic lights, artillery blasts, tracers, AA flak, and
   * helicopter-reactive smoke clouds. Returns live combat telemetry for crew sync.
   */
  update: (
    timeSec: number,
    dt: number,
    ctxOrCallback?: WarzoneUpdateContext | ((intensity01: number) => void),
  ) => WarzoneFrameTelemetry;
  /** Read-only snapshot of active smoke cloud world positions (for testing rotor-wash displacement). */
  getSmokeCloudPositions: (out?: THREE.Vector3[]) => THREE.Vector3[];
  dispose: () => void;
}

/**
 * Pure rotor-wash aerodynamics helper: computes radial downwash + tangential swirl + wake drag
 * acceleration on a smoke cloud particle from a nearby moving helicopter.
 */
export function computeHelicopterSmokeWakeImpulse(
  smokePos: THREE.Vector3,
  emitter: HelicopterWakeEmitter,
  outImpulse: THREE.Vector3,
): number {
  const dx = smokePos.x - emitter.position.x;
  const dz = smokePos.z - emitter.position.z;
  const dy = smokePos.y - emitter.position.y;

  // Rotor downwash affects air column from slightly above rotor hub (+5m) down to ground (-32m)
  if (dy > 5.5 || dy < -34.0) {
    outImpulse.set(0, 0, 0);
    return 0;
  }

  const horizDistSq = dx * dx + dz * dz;
  const influenceRadius = Math.max(8, emitter.rotorRadiusM * 3.4);
  if (horizDistSq >= influenceRadius * influenceRadius) {
    outImpulse.set(0, 0, 0);
    return 0;
  }

  const horizDist = Math.sqrt(horizDistSq);
  const radialFalloff = 1 - horizDist / influenceRadius;
  const vertFalloff = dy <= 0 ? 1 - Math.abs(dy) / 34.0 : 1 - dy / 5.5;
  const weight = radialFalloff * radialFalloff * Math.max(0, vertFalloff) * emitter.downwashStrength;

  if (weight <= 0.0005) {
    outImpulse.set(0, 0, 0);
    return 0;
  }

  const invD = horizDist > 0.05 ? 1 / horizDist : 0;
  const rx = horizDist > 0.05 ? dx * invD : 1;
  const rz = horizDist > 0.05 ? dz * invD : 0;
  // Counter-clockwise rotor vortex tangent (-rz, rx)
  const tx = -rz;
  const tz = rx;

  // Outward radial blast + rotor vortex swirl + horizontal wake entrainment from helicopter movement
  const push = weight * 14.5;
  const swirl = weight * 9.2;
  const downPush = dy < 0 && smokePos.y > 2.2 ? -weight * 5.8 : weight * 2.4;

  outImpulse.set(
    rx * push + tx * swirl + emitter.velocity.x * weight * 0.55,
    downPush + emitter.velocity.y * weight * 0.25,
    rz * push + tz * swirl + emitter.velocity.z * weight * 0.55,
  );

  return outImpulse.length();
}

/**
 * Zero-GC Particle & Light Management System for aerial transit cinematics.
 * Combines:
 * - Priority-based `WarzoneLightManager` (artillery blasts, AA flak, escort muzzle, flares)
 * - Dynamic rotor-wash-reactive volumetric smoke clouds reacting to escort & transport helicopters
 * - Ballistic artillery embers/debris, high-intensity faction tracers, AA flak airbursts,
 *   burning wrecks, sweeping watchtower searchlights, and drifting flares
 * - Live `WarzoneCombatEvent` & telemetry output synchronizing helicopter door gunner & squadmate!
 */
export function buildWarzoneBattlefieldVfx(isSoftwareGl: boolean): CinematicWarzoneVfx {
  const root = new THREE.Group();
  root.name = 'CinematicWarzoneParticleAndLightSystem';

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

  // --- 0. Pooled Dynamic Light Manager (strictly zero shadow casters) ---
  const lightManager = new WarzoneLightManager(isSoftwareGl ? 3 : 5);
  root.add(lightManager.root);

  // --- 1. High-Intensity Valley Tracer Crossfire & AA Streams (26 pooled bolts) ---
  const tracerGeo = trackGeo(new THREE.CylinderGeometry(0.06, 0.06, 5.2, 5));
  tracerGeo.rotateX(Math.PI * 0.5);
  const friendlyTracerMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xfef08a, transparent: true, opacity: 0.95 }),
  );
  const hostileTracerMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xf87171, transparent: true, opacity: 0.95 }),
  );
  const aaTracerMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xfb923c, transparent: true, opacity: 0.92 }),
  );

  const tracerSpecs: Array<{
    start: [number, number, number];
    end: [number, number, number];
    kind: 'friendly' | 'hostile' | 'aa';
    period: number;
    offset: number;
    flight: number;
  }> = [
    { start: [-26, 2.2, -24], end: [28, 3.8, -56], kind: 'friendly', period: 1.25, offset: 0.1, flight: 0.5 },
    { start: [-24, 2.5, -26], end: [24, 3.2, -52], kind: 'friendly', period: 1.25, offset: 0.3, flight: 0.5 },
    { start: [29, 4.2, -58], end: [-22, 2.4, -22], kind: 'hostile', period: 1.4, offset: 0.45, flight: 0.54 },
    { start: [26, 3.6, -54], end: [-26, 2.8, -28], kind: 'hostile', period: 1.4, offset: 0.68, flight: 0.54 },
    { start: [-42, 6.5, -48], end: [12, 2.2, -32], kind: 'hostile', period: 1.65, offset: 0.22, flight: 0.58 },
    { start: [-40, 6.2, -46], end: [16, 2.6, -34], kind: 'hostile', period: 1.65, offset: 0.44, flight: 0.58 },
    { start: [18, 5.5, -18], end: [-38, 7.2, -52], kind: 'friendly', period: 1.55, offset: 0.55, flight: 0.55 },
    { start: [20, 5.8, -19], end: [-34, 6.5, -56], kind: 'friendly', period: 1.55, offset: 0.78, flight: 0.55 },
    { start: [-18, 2.0, -72], end: [36, 4.5, -84], kind: 'friendly', period: 1.35, offset: 0.15, flight: 0.52 },
    { start: [38, 5.0, -82], end: [-20, 2.5, -68], kind: 'hostile', period: 1.45, offset: 0.85, flight: 0.54 },
    { start: [-52, 8.0, -32], end: [-8, 1.8, -40], kind: 'hostile', period: 1.75, offset: 0.35, flight: 0.58 },
    { start: [-10, 2.4, -38], end: [-50, 8.5, -35], kind: 'friendly', period: 1.6, offset: 0.92, flight: 0.56 },
    { start: [44, 6.0, -36], end: [-6, 2.2, -48], kind: 'hostile', period: 1.5, offset: 0.12, flight: 0.53 },
    { start: [-4, 2.2, -46], end: [42, 6.4, -38], kind: 'friendly', period: 1.5, offset: 0.7, flight: 0.53 },
    { start: [-32, 3.0, -14], end: [16, 4.0, -40], kind: 'friendly', period: 1.3, offset: 0.4, flight: 0.48 },
    { start: [32, 3.5, -24], end: [-18, 2.5, -44], kind: 'hostile', period: 1.35, offset: 0.95, flight: 0.48 },
    // Rising AA flak tracer streams into the flight corridor
    { start: [-48, 2.0, -68], end: [-12, 46, -42], kind: 'aa', period: 2.0, offset: 0.0, flight: 0.68 },
    { start: [-48, 2.0, -68], end: [-10, 48, -40], kind: 'aa', period: 2.0, offset: 0.22, flight: 0.68 },
    { start: [46, 2.0, -74], end: [8, 44, -44], kind: 'aa', period: 2.2, offset: 0.65, flight: 0.72 },
    { start: [46, 2.0, -74], end: [11, 47, -42], kind: 'aa', period: 2.2, offset: 0.88, flight: 0.72 },
    { start: [-32, 2.0, -92], end: [4, 52, -52], kind: 'aa', period: 1.95, offset: 1.1, flight: 0.66 },
    { start: [28, 2.0, -88], end: [-16, 48, -48], kind: 'aa', period: 2.1, offset: 1.4, flight: 0.68 },
    { start: [-36, 2.0, -38], end: [-8, 34, -22], kind: 'aa', period: 2.35, offset: 0.5, flight: 0.62 },
    { start: [34, 2.0, -34], end: [6, 32, -20], kind: 'aa', period: 2.45, offset: 1.25, flight: 0.62 },
    // Watchtower perimeter defense fire
    { start: [-24, 9.5, -18], end: [-46, 2.5, -42], kind: 'friendly', period: 1.4, offset: 0.2, flight: 0.46 },
    { start: [24, 9.5, -18], end: [48, 2.8, -46], kind: 'friendly', period: 1.45, offset: 0.6, flight: 0.46 },
  ];

  const valleyTracers: ValleyTracerSlot[] = [];
  for (const spec of tracerSpecs) {
    const mat =
      spec.kind === 'friendly'
        ? friendlyTracerMat
        : spec.kind === 'hostile'
          ? hostileTracerMat
          : aaTracerMat;
    const mesh = new THREE.Mesh(tracerGeo, mat);
    const start = new THREE.Vector3(...spec.start);
    const end = new THREE.Vector3(...spec.end);
    mesh.position.copy(start);
    mesh.lookAt(end);
    mesh.visible = false;
    root.add(mesh);
    valleyTracers.push({
      mesh,
      start,
      end,
      periodSec: spec.period,
      offsetSec: spec.offset,
      flightSec: spec.flight,
      isHostile: spec.kind !== 'friendly',
    });
  }

  // --- 2. Dynamic Helicopter-Reactive Smoke Cloud Pool (36 billowed clouds) ---
  const smokeGeo = trackGeo(new THREE.DodecahedronGeometry(1.0, 1));
  const smokeCount = isSoftwareGl ? 24 : 36;
  const smokeClouds: DynamicSmokeCloudSlot[] = [];
  const smokeAnchors: Array<[number, number, number]> = [
    [-16, 1.8, -26],
    [19, 1.8, -42],
    [-22, 1.8, -62],
    [26, 1.8, -18],
    [-28, 1.5, -44],
    [30, 1.5, -52],
    [-8, 3.2, -34],
    [8, 3.0, -30],
    [-18, 4.2, -46],
    [14, 4.0, -48],
    [-6, 2.6, -18],
    [10, 2.6, -20],
  ];

  for (let i = 0; i < smokeCount; i++) {
    const shade = 0x171a1f + (i % 3) * 0x060708;
    const mat = trackMat(
      new THREE.MeshStandardMaterial({
        color: shade,
        roughness: 0.96,
        metalness: 0.02,
        transparent: true,
        opacity: 0.56,
      }),
    );
    const mesh = new THREE.Mesh(smokeGeo, mat);
    const anchor = smokeAnchors[i % smokeAnchors.length];
    const life = 7.2 + (i % 5) * 1.1;
    const initialAge = (i / smokeCount) * life;
    const origin = new THREE.Vector3(
      anchor[0] + ((i % 3) - 1) * 2.4,
      anchor[1],
      anchor[2] + (((i * 7) % 5) - 2) * 2.1,
    );
    const pos = origin.clone().add(new THREE.Vector3(initialAge * 0.45, initialAge * 2.1, initialAge * 0.25));
    mesh.position.copy(pos);
    root.add(mesh);
    smokeClouds.push({
      mesh,
      pos,
      vel: new THREE.Vector3(0.45 + (i % 3) * 0.14, 2.0 + (i % 4) * 0.22, 0.2),
      origin,
      ageSec: initialAge,
      lifeSec: life,
      baseScale: 1.6 + (i % 3) * 0.45,
      maxScale: 5.4 + (i % 4) * 0.95,
      swirlSeed: i * 1.37,
      active: true,
    });
  }
  let smokeBurstCursor = 0;

  // --- 3. Ballistic Artillery Ember & Debris Particle Pool (32 embers) ---
  const emberGeo = trackGeo(new THREE.BoxGeometry(0.18, 0.18, 0.65));
  const emberMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.95 }),
  );
  const embers: BlastEmberSlot[] = [];
  const emberCount = isSoftwareGl ? 18 : 32;
  for (let i = 0; i < emberCount; i++) {
    const mesh = new THREE.Mesh(emberGeo, emberMat);
    mesh.visible = false;
    root.add(mesh);
    embers.push({
      mesh,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      ageSec: 0,
      maxAgeSec: 1.2,
      active: false,
    });
  }
  let emberCursor = 0;

  const spawnArtilleryBurstParticles = (origin: THREE.Vector3): void => {
    // Erupt hot ballistic embers & shrapnel upward
    const count = isSoftwareGl ? 6 : 10;
    for (let i = 0; i < count; i++) {
      const e = embers[emberCursor];
      emberCursor = (emberCursor + 1) % embers.length;
      const angle = (i / count) * Math.PI * 2 + (emberCursor % 7) * 0.29;
      const horizSpd = 6.5 + (i % 4) * 2.8;
      e.pos.set(origin.x, origin.y + 1.1, origin.z);
      e.vel.set(Math.cos(angle) * horizSpd, 10.5 + (i % 3) * 4.2, Math.sin(angle) * horizSpd);
      e.ageSec = 0;
      e.maxAgeSec = 1.05 + (i % 3) * 0.25;
      e.active = true;
      e.mesh.position.copy(e.pos);
      e.mesh.scale.setScalar(1.25);
      e.mesh.visible = true;
    }
    // Seed 2 billowing blast smoke clouds directly from the detonation crater (reactive to helicopter wake!)
    for (let s = 0; s < 2; s++) {
      const cloud = smokeClouds[smokeBurstCursor];
      smokeBurstCursor = (smokeBurstCursor + 1) % smokeClouds.length;
      cloud.origin.set(origin.x + (s - 0.5) * 2.6, origin.y + 1.2, origin.z + (s - 0.5) * 2.0);
      cloud.pos.copy(cloud.origin);
      cloud.vel.set((s - 0.5) * 3.2, 4.4 + s * 1.1, 0.8);
      cloud.ageSec = 0;
      cloud.lifeSec = 6.4;
      cloud.baseScale = 2.4;
      cloud.maxScale = 7.4;
      cloud.active = true;
    }
  };

  // --- 4. Artillery / Mortar Detonation Sites (6 rhythmic blast zones) ---
  const fireballGeo = trackGeo(new THREE.SphereGeometry(1.0, 10, 8));
  const ringGeo = trackGeo(new THREE.RingGeometry(0.85, 1.0, 18));
  ringGeo.rotateX(-Math.PI * 0.5);

  const blastConfigs: Array<{ pos: [number, number, number]; period: number; offset: number }> = [
    { pos: [-28, 0.4, -44], period: 4.9, offset: 0.5 },
    { pos: [30, 0.4, -52], period: 5.6, offset: 1.9 },
    { pos: [-14, 0.4, -74], period: 5.3, offset: 3.1 },
    { pos: [22, 0.4, -30], period: 5.9, offset: 1.3 },
    { pos: [-40, 0.6, -26], period: 6.4, offset: 3.9 },
    { pos: [40, 0.6, -68], period: 5.4, offset: 2.6 },
  ];

  const artillerySites: ArtillerySiteSlot[] = [];
  for (const cfg of blastConfigs) {
    const fbMat = trackMat(
      new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.94 }),
    );
    const fireball = new THREE.Mesh(fireballGeo, fbMat);
    fireball.position.set(cfg.pos[0], cfg.pos[1] + 1.0, cfg.pos[2]);
    fireball.visible = false;
    root.add(fireball);

    const rMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0xffedd5,
        transparent: true,
        opacity: 0.74,
        side: THREE.DoubleSide,
      }),
    );
    const ring = new THREE.Mesh(ringGeo, rMat);
    ring.position.set(cfg.pos[0], 0.25, cfg.pos[2]);
    ring.visible = false;
    root.add(ring);

    artillerySites.push({
      pos: new THREE.Vector3(...cfg.pos),
      periodSec: cfg.period,
      offsetSec: cfg.offset,
      lastCycle: -1,
      fireball,
      ring,
    });
  }

  // --- 5. Mid-Air AA Flak Airbursts along Flight Approach (6 sky bursts) ---
  const flakSpecs: Array<{ pos: [number, number, number]; period: number; offset: number }> = [
    { pos: [-18, 19, -46], period: 4.4, offset: 0.9 },
    { pos: [14, 21, -40], period: 4.8, offset: 2.2 },
    { pos: [-24, 15, -28], period: 5.1, offset: 3.4 },
    { pos: [18, 16, -26], period: 4.6, offset: 1.5 },
    { pos: [-8, 24, -60], period: 5.3, offset: 0.3 },
    { pos: [10, 22, -56], period: 5.0, offset: 2.8 },
  ];
  const flakSlots: AaFlakSlot[] = [];
  for (const fl of flakSpecs) {
    const fMat = trackMat(
      new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.95 }),
    );
    const flashMesh = new THREE.Mesh(fireballGeo, fMat);
    flashMesh.position.set(...fl.pos);
    flashMesh.visible = false;

    const pMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x111317,
        roughness: 0.98,
        transparent: true,
        opacity: 0.72,
      }),
    );
    const puffMesh = new THREE.Mesh(smokeGeo, pMat);
    puffMesh.position.set(...fl.pos);
    puffMesh.visible = false;

    root.add(flashMesh, puffMesh);
    flakSlots.push({
      pos: new THREE.Vector3(...fl.pos),
      periodSec: fl.period,
      offsetSec: fl.offset,
      lastCycle: -1,
      flashMesh,
      puffMesh,
    });
  }

  // --- 6. Burning Armored Wrecks (4 perimeter silhouettes) ---
  const wreckHullMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x16181a, roughness: 0.9, metalness: 0.25 }),
  );
  const wreckFireMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xf97316, transparent: true, opacity: 0.88 }),
  );
  const wreckGeo = trackGeo(new THREE.BoxGeometry(2.6, 1.35, 5.2));
  const wreckSpecs: Array<{ pos: [number, number, number]; rotY: number; phase: number }> = [
    { pos: [-16, 0.65, -26], rotY: 0.48, phase: 0.0 },
    { pos: [19, 0.65, -42], rotY: -0.62, phase: 1.7 },
    { pos: [-22, 0.65, -62], rotY: 1.12, phase: 3.1 },
    { pos: [26, 0.65, -18], rotY: -0.35, phase: 4.5 },
  ];

  const burningWrecks: BurningWreckSlot[] = [];
  for (const w of wreckSpecs) {
    const hull = new THREE.Mesh(wreckGeo, wreckHullMat);
    hull.position.set(...w.pos);
    hull.rotation.set(0.08, w.rotY, -0.09);
    root.add(hull);

    const fireMesh = new THREE.Mesh(fireballGeo, wreckFireMat);
    fireMesh.position.set(w.pos[0], w.pos[1] + 0.95, w.pos[2]);
    fireMesh.scale.set(1.1, 1.4, 1.1);
    root.add(fireMesh);

    burningWrecks.push({
      fireMesh,
      basePos: new THREE.Vector3(...w.pos),
      phaseOffset: w.phase,
    });
  }

  // --- 7. Sweeping Watchtower Searchlight Beams (4 cones) ---
  const beamGeo = trackGeo(new THREE.ConeGeometry(4.6, 48, 12, 1, true));
  beamGeo.translate(0, -24, 0);
  beamGeo.rotateX(Math.PI * 0.5);
  const beamMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0xdbeafe,
      transparent: true,
      opacity: 0.09,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const searchlightSpecs: Array<{ pos: [number, number, number]; baseYaw: number; speed: number; phase: number }> = [
    { pos: [-24, 10.9, -18], baseYaw: 0.45, speed: 0.42, phase: 0.0 },
    { pos: [24, 10.9, -18], baseYaw: -0.55, speed: 0.36, phase: 1.8 },
    { pos: [-26, 10.9, -54], baseYaw: 0.25, speed: 0.48, phase: 3.2 },
    { pos: [26, 10.9, -54], baseYaw: -0.35, speed: 0.4, phase: 4.9 },
  ];
  const searchlights: SearchlightSlot[] = [];
  for (const sl of searchlightSpecs) {
    const pivot = new THREE.Group();
    pivot.position.set(...sl.pos);
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.rotation.x = 0.42;
    pivot.add(beam);
    root.add(pivot);
    searchlights.push({
      pivot,
      baseYaw: sl.baseYaw,
      speed: sl.speed,
      phase: sl.phase,
    });
  }

  // --- 8. Slow-Falling Amber Battlefield Illumination Flares (2 flares) ---
  const flareGeo = trackGeo(new THREE.SphereGeometry(0.45, 8, 6));
  const flareMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xfef3c7, transparent: true, opacity: 0.96 }),
  );
  const flareSpecs = [
    { x: -16, z: -48, phase: 0.1 },
    { x: 22, z: -64, phase: 0.55 },
  ];
  const flares: FlareSlot[] = [];
  for (const fl of flareSpecs) {
    const mesh = new THREE.Mesh(flareGeo, flareMat);
    root.add(mesh);
    flares.push({ mesh, x: fl.x, z: fl.z, phaseOffset: fl.phase });
  }

  // Pre-allocated zero-GC scratch objects for update()
  const _tmpPos = new THREE.Vector3();
  const _wakeImpulse = new THREE.Vector3();
  const _lightPos = new THREE.Vector3();
  const _primaryThreat = new THREE.Vector3(-28, 2.0, -44);
  const _eventScratch: { kind: WarzoneCombatEvent['kind']; position: THREE.Vector3; intensity01: number } = {
    kind: 'artillery_blast',
    position: new THREE.Vector3(),
    intensity01: 0,
  };
  let rollingCombatHeat = 0.25;

  const update = (
    timeSec: number,
    dt: number,
    ctxOrCallback?: WarzoneUpdateContext | ((intensity01: number) => void),
  ): WarzoneFrameTelemetry => {
    const safeDt = Math.min(0.05, Math.max(0.001, dt));
    const ctx: WarzoneUpdateContext | undefined =
      typeof ctxOrCallback === 'function' ? undefined : ctxOrCallback;
    const legacyBlastCb = typeof ctxOrCallback === 'function' ? ctxOrCallback : undefined;
    const wakeEmitters = ctx?.wakeEmitters;

    rollingCombatHeat = Math.max(0.18, rollingCombatHeat - safeDt * 0.28);

    // 1. Update valley tracer crossfire & AA streams
    for (let i = 0; i < valleyTracers.length; i++) {
      const tr = valleyTracers[i];
      const local = (timeSec + tr.offsetSec) % tr.periodSec;
      if (local <= tr.flightSec) {
        const u = local / tr.flightSec;
        _tmpPos.lerpVectors(tr.start, tr.end, u);
        tr.mesh.position.copy(_tmpPos);
        tr.mesh.visible = true;
      } else {
        tr.mesh.visible = false;
      }
    }

    // 2. Update artillery detonations -> trigger pooled dynamic lights, embers, smoke & combat events
    for (let i = 0; i < artillerySites.length; i++) {
      const site = artillerySites[i];
      const shifted = timeSec + site.offsetSec;
      const cycle = Math.floor(shifted / site.periodSec);
      const local = shifted - cycle * site.periodSec;

      if (cycle !== site.lastCycle && timeSec > 0.2) {
        site.lastCycle = cycle;
        const intensity = 0.72 + (i % 3) * 0.12;
        rollingCombatHeat = Math.min(1, rollingCombatHeat + 0.55);
        _primaryThreat.copy(site.pos);

        _lightPos.set(site.pos.x, site.pos.y + 4.5, site.pos.z);
        lightManager.triggerFlash(_lightPos, 0xff9a3c, 68 * intensity, 95, 1.15, 10);
        spawnArtilleryBurstParticles(site.pos);

        if (legacyBlastCb) {
          legacyBlastCb(intensity);
        } else if (ctx?.onCombatEvent) {
          _eventScratch.kind = 'artillery_blast';
          _eventScratch.position.copy(site.pos);
          _eventScratch.intensity01 = intensity;
          ctx.onCombatEvent(_eventScratch);
        }
      }

      if (local < 1.2) {
        const u = local / 1.2;
        const scale = 1.4 + Math.sin(u * Math.PI) * 5.8;
        site.fireball.visible = true;
        site.fireball.scale.set(scale, scale * 1.18, scale);
        site.fireball.position.set(site.pos.x, site.pos.y + 0.8 + u * 2.8, site.pos.z);
        (site.fireball.material as THREE.MeshBasicMaterial).opacity = (1 - u) * 0.94;

        site.ring.visible = true;
        const rScale = 1.0 + u * 16.0;
        site.ring.scale.set(rScale, rScale, rScale);
        (site.ring.material as THREE.MeshBasicMaterial).opacity = (1 - u) * 0.68;
      } else {
        site.fireball.visible = false;
        site.ring.visible = false;
      }
    }

    // 3. Update mid-air AA flak airbursts (flash + dynamic light + expanding black flak cloud)
    for (let i = 0; i < flakSlots.length; i++) {
      const fl = flakSlots[i];
      const shifted = timeSec + fl.offsetSec;
      const cycle = Math.floor(shifted / fl.periodSec);
      const local = shifted - cycle * fl.periodSec;

      if (cycle !== fl.lastCycle && timeSec > 0.35) {
        fl.lastCycle = cycle;
        rollingCombatHeat = Math.min(1, rollingCombatHeat + 0.42);
        _primaryThreat.copy(fl.pos);
        lightManager.triggerFlash(fl.pos, 0xffd166, 42, 65, 0.38, 8);
        if (ctx?.onCombatEvent) {
          _eventScratch.kind = 'aa_flak';
          _eventScratch.position.copy(fl.pos);
          _eventScratch.intensity01 = 0.78;
          ctx.onCombatEvent(_eventScratch);
        }
      }

      if (local < 0.24) {
        const u = local / 0.24;
        fl.flashMesh.visible = true;
        fl.flashMesh.scale.setScalar(1.2 + Math.sin(u * Math.PI) * 2.4);
        (fl.flashMesh.material as THREE.MeshBasicMaterial).opacity = (1 - u) * 0.95;
      } else {
        fl.flashMesh.visible = false;
      }

      if (local >= 0.08 && local < 2.8) {
        const pu = (local - 0.08) / 2.72;
        fl.puffMesh.visible = true;
        fl.puffMesh.scale.setScalar(1.1 + pu * 3.8);
        fl.puffMesh.position.set(
          fl.pos.x + pu * 2.6,
          fl.pos.y + pu * 1.4,
          fl.pos.z + pu * 1.1,
        );
        (fl.puffMesh.material as THREE.MeshStandardMaterial).opacity = (1 - pu) * 0.7;
      } else {
        fl.puffMesh.visible = false;
      }
    }

    // 4. Inject escort gunship muzzle light pulse into pooled light manager when firing
    if (ctx?.escortMuzzleLightPos && (ctx.escortMuzzleIntensity ?? 0) > 0.05) {
      lightManager.triggerFlash(
        ctx.escortMuzzleLightPos,
        0xffd166,
        ctx.escortMuzzleIntensity ?? 28,
        52,
        0.12,
        6,
      );
    }

    // 5. Step ballistic blast embers under gravity
    for (let i = 0; i < embers.length; i++) {
      const e = embers[i];
      if (!e.active) continue;
      e.ageSec += safeDt;
      if (e.ageSec >= e.maxAgeSec || e.pos.y < 0.05) {
        e.active = false;
        e.mesh.visible = false;
      } else {
        e.vel.y -= 13.5 * safeDt;
        e.pos.addScaledVector(e.vel, safeDt);
        e.mesh.position.copy(e.pos);
        const fade = 1 - e.ageSec / e.maxAgeSec;
        e.mesh.scale.setScalar(Math.max(0.1, fade * 1.25));
      }
    }

    // 6. Step Dynamic Smoke Clouds with live Helicopter Rotor-Wash & Movement Physics!
    let smokeWakeDisplacementSum = 0;
    for (let i = 0; i < smokeClouds.length; i++) {
      const c = smokeClouds[i];
      c.ageSec += safeDt;
      if (c.ageSec >= c.lifeSec) {
        c.ageSec = 0;
        c.pos.copy(c.origin);
        c.vel.set(0.45 + (i % 3) * 0.14, 1.95 + (i % 4) * 0.22, 0.2);
      }

      // Ambient wind + buoyancy baseline
      c.vel.x = THREE.MathUtils.damp(c.vel.x, 0.65 + Math.sin(timeSec * 0.4 + c.swirlSeed) * 0.35, 1.4, safeDt);
      c.vel.y = THREE.MathUtils.damp(c.vel.y, 1.9, 1.2, safeDt);
      c.vel.z = THREE.MathUtils.damp(c.vel.z, 0.28, 1.4, safeDt);

      // Apply physical rotor downwash & wake entrainment from escort and transport helicopters!
      let turbulenceBoost = 0;
      if (wakeEmitters) {
        for (let w = 0; w < wakeEmitters.length; w++) {
          const mag = computeHelicopterSmokeWakeImpulse(c.pos, wakeEmitters[w], _wakeImpulse);
          if (mag > 0.001) {
            c.vel.addScaledVector(_wakeImpulse, safeDt);
            turbulenceBoost += mag * 0.05;
            smokeWakeDisplacementSum += mag * safeDt;
          }
        }
      }

      c.pos.addScaledVector(c.vel, safeDt);
      if (c.pos.y < 0.75) {
        c.pos.y = 0.75;
        if (c.vel.y < 0) c.vel.y = -c.vel.y * 0.25;
      }

      const lifeU = c.ageSec / c.lifeSec;
      const scale =
        THREE.MathUtils.lerp(c.baseScale, c.maxScale, Math.pow(lifeU, 0.72)) *
        (1 + Math.min(0.65, turbulenceBoost));
      c.mesh.position.copy(c.pos);
      c.mesh.scale.set(scale * 1.15, scale * 0.82, scale * 1.15);
      c.mesh.rotation.set(
        lifeU * 1.1 + turbulenceBoost * 0.35,
        timeSec * (0.28 + turbulenceBoost * 0.5) + c.swirlSeed,
        0,
      );
      const alpha = Math.sin(lifeU * Math.PI) * 0.62;
      (c.mesh.material as THREE.MeshStandardMaterial).opacity = Math.max(0.02, alpha);
    }

    // 7. Burning armored wrecks fire flicker
    for (let i = 0; i < burningWrecks.length; i++) {
      const w = burningWrecks[i];
      const flicker = 0.85 + Math.sin(timeSec * 14.0 + w.phaseOffset) * 0.28;
      w.fireMesh.scale.set(1.1 * flicker, 1.45 * flicker, 1.1 * flicker);
      w.fireMesh.rotation.y = timeSec * 1.8 + w.phaseOffset;
    }

    // 8. Watchtower searchlights & slow-falling battlefield flares
    for (let i = 0; i < searchlights.length; i++) {
      const sl = searchlights[i];
      sl.pivot.rotation.y = sl.baseYaw + Math.sin(timeSec * sl.speed + sl.phase) * 0.72;
    }

    for (let i = 0; i < flares.length; i++) {
      const fl = flares[i];
      const u = (timeSec * 0.075 + fl.phaseOffset) % 1;
      fl.mesh.position.set(
        fl.x + Math.sin(timeSec * 0.8 + i * 2) * 1.8,
        36 - u * 28,
        fl.z + Math.cos(timeSec * 0.6 + i) * 1.4,
      );
      const pulse = 0.9 + Math.sin(timeSec * 18 + i * 3) * 0.25;
      fl.mesh.scale.setScalar(pulse);
    }

    const activeLightCount = lightManager.update(safeDt);

    return {
      combatIntensity01: THREE.MathUtils.clamp(rollingCombatHeat, 0, 1),
      primaryThreatPos: _primaryThreat,
      activeLightCount,
      smokeWakeDisplacementSum,
    };
  };

  const getSmokeCloudPositions = (out?: THREE.Vector3[]): THREE.Vector3[] => {
    const arr = out ?? [];
    arr.length = smokeClouds.length;
    for (let i = 0; i < smokeClouds.length; i++) {
      if (!arr[i]) arr[i] = new THREE.Vector3();
      arr[i].copy(smokeClouds[i].pos);
    }
    return arr;
  };

  return {
    root,
    lightManager,
    update,
    getSmokeCloudPositions,
    dispose: () => {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

// ============================================================================
// CORRIDOR GUN-CAM FIREFIGHT VFX POOL (MUTUAL TRACERS + HIT SPARKS + DUST)
// ============================================================================

interface CorridorTracerSlot {
  mesh: THREE.Mesh;
  start: THREE.Vector3;
  end: THREE.Vector3;
  ageSec: number;
  maxAgeSec: number;
  active: boolean;
}

interface CorridorSparkSlot {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  ageSec: number;
  maxAgeSec: number;
  active: boolean;
}

export interface CorridorCombatVfx {
  root: THREE.Group;
  spawnTracer: (from: THREE.Vector3, to: THREE.Vector3, isHostile: boolean) => void;
  spawnImpactBurst: (pos: THREE.Vector3, isKill: boolean) => void;
  update: (dt: number) => void;
  reset: () => void;
  dispose: () => void;
}

/**
 * Zero-GC pooled corridor tracer bolts and metallic/concrete hit spark bursts
 * for unmistakable gun-mounted camera firefights.
 */
export function buildCorridorCombatVfx(): CorridorCombatVfx {
  const root = new THREE.Group();
  root.name = 'CorridorCombatVfx';

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

  const tracerGeo = trackGeo(new THREE.CylinderGeometry(0.016, 0.016, 1.35, 5));
  tracerGeo.rotateX(Math.PI * 0.5);
  const friendlyMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xfef08a, transparent: true, opacity: 0.96 }),
  );
  const hostileMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xff5555, transparent: true, opacity: 0.96 }),
  );

  const tracers: CorridorTracerSlot[] = [];
  for (let i = 0; i < 10; i++) {
    const mesh = new THREE.Mesh(tracerGeo, friendlyMat);
    mesh.visible = false;
    root.add(mesh);
    tracers.push({
      mesh,
      start: new THREE.Vector3(),
      end: new THREE.Vector3(),
      ageSec: 0,
      maxAgeSec: 0.14,
      active: false,
    });
  }
  let tracerCursor = 0;

  const sparkGeo = trackGeo(new THREE.BoxGeometry(0.038, 0.038, 0.14));
  const sparkMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.96 }),
  );
  const sparks: CorridorSparkSlot[] = [];
  for (let i = 0; i < 24; i++) {
    const mesh = new THREE.Mesh(sparkGeo, sparkMat);
    mesh.visible = false;
    root.add(mesh);
    sparks.push({
      mesh,
      vel: new THREE.Vector3(),
      ageSec: 0,
      maxAgeSec: 0.28,
      active: false,
    });
  }
  let sparkCursor = 0;

  const impactLight = new THREE.PointLight(0xff9e44, 0, 8.5, 1.5);
  root.add(impactLight);
  let impactLightTimer = 0;

  const _tmp = new THREE.Vector3();

  const spawnTracer = (from: THREE.Vector3, to: THREE.Vector3, isHostile: boolean): void => {
    const slot = tracers[tracerCursor];
    tracerCursor = (tracerCursor + 1) % tracers.length;
    slot.start.copy(from);
    slot.end.copy(to);
    slot.ageSec = 0;
    slot.maxAgeSec = isHostile ? 0.2 : 0.15;
    slot.active = true;
    slot.mesh.material = isHostile ? hostileMat : friendlyMat;
    slot.mesh.position.copy(from);
    slot.mesh.lookAt(to);
    slot.mesh.visible = true;
  };

  const spawnImpactBurst = (pos: THREE.Vector3, isKill: boolean): void => {
    const count = isKill ? 9 : 5;
    for (let i = 0; i < count; i++) {
      const slot = sparks[sparkCursor];
      sparkCursor = (sparkCursor + 1) % sparks.length;
      const angle = (i / count) * Math.PI * 2 + (sparkCursor % 5) * 0.37;
      const speed = (isKill ? 3.8 : 2.6) + (i % 3) * 0.9;
      slot.mesh.position.copy(pos);
      slot.vel.set(
        Math.cos(angle) * speed * 0.75,
        0.9 + Math.abs(Math.sin(angle)) * speed * 0.75,
        (isKill ? 2.2 : 1.5) + (i % 2) * 1.1,
      );
      slot.ageSec = 0;
      slot.maxAgeSec = isKill ? 0.38 : 0.26;
      slot.active = true;
      slot.mesh.scale.setScalar(isKill ? 1.3 : 1.0);
      slot.mesh.visible = true;
    }
    impactLight.position.copy(pos);
    impactLight.intensity = isKill ? 14 : 8;
    impactLightTimer = isKill ? 0.16 : 0.1;
  };

  const update = (dt: number): void => {
    for (let i = 0; i < tracers.length; i++) {
      const tr = tracers[i];
      if (!tr.active) continue;
      tr.ageSec += dt;
      if (tr.ageSec >= tr.maxAgeSec) {
        tr.active = false;
        tr.mesh.visible = false;
      } else {
        const u = tr.ageSec / tr.maxAgeSec;
        _tmp.lerpVectors(tr.start, tr.end, u);
        tr.mesh.position.copy(_tmp);
      }
    }

    for (let i = 0; i < sparks.length; i++) {
      const sp = sparks[i];
      if (!sp.active) continue;
      sp.ageSec += dt;
      if (sp.ageSec >= sp.maxAgeSec) {
        sp.active = false;
        sp.mesh.visible = false;
      } else {
        sp.vel.y -= 9.8 * dt;
        sp.mesh.position.addScaledVector(sp.vel, dt);
        const fade = 1 - sp.ageSec / sp.maxAgeSec;
        sp.mesh.scale.setScalar(Math.max(0.05, fade));
      }
    }

    if (impactLightTimer > 0) {
      impactLightTimer = Math.max(0, impactLightTimer - dt);
      impactLight.intensity = impactLightTimer > 0 ? impactLightTimer * 85 : 0;
    }
  };

  const reset = (): void => {
    for (const tr of tracers) {
      tr.active = false;
      tr.mesh.visible = false;
    }
    for (const sp of sparks) {
      sp.active = false;
      sp.mesh.visible = false;
    }
    impactLight.intensity = 0;
    impactLightTimer = 0;
  };

  return {
    root,
    spawnTracer,
    spawnImpactBurst,
    update,
    reset,
    dispose: () => {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

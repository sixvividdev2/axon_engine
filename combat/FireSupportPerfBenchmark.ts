import * as THREE from 'three';
import {
  BodycamAudio,
  FIRE_SUPPORT_MAX_VOICES,
} from '../bodycam-sdk/BodycamAudio';
import {
  AIR_STRIKE_MAX_TRIANGLES_PER_AIRCRAFT,
  BomberAirStrikeSystem,
  MAX_BOMBER_POOL,
  countGeometryTriangles,
} from './BomberAirStrikeSystem';
import {
  MAX_MORTAR_PITS,
  MAX_MORTAR_SHELL_POOL,
  MAX_SCORCH_DECAL_POOL,
  MORTAR_HQ_EXCLUSION_RADIUS_M,
  MortarEmplacementSystem,
  MortarExclusionZone,
  MortarSiteConfig,
} from './MortarEmplacementSystem';

export type FireSupportBenchTier = 'TIER_A_SOFTWARE' | 'TIER_B_HARDWARE';

export const BENCH_CPU_P95_BUDGET_MS = 1.5;
export const BENCH_GPU_P95_BUDGET_MS = 1.0;
export const BENCH_TOTAL_FRAME_P95_BUDGET_MS = 16.6;
export const BENCH_MAX_FIRE_SUPPORT_DRAW_CALLS = 28;
export const BENCH_MAX_FIRE_SUPPORT_TRIANGLES = 18000;
export const BENCH_MAX_SHADOW_CASTERS = 1;
export const BENCH_DEFAULT_DURATION_SEC = 10;

const SOFTWARE_RENDERER_REGEX = /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i;

export interface FireSupportPoolDetails {
  pitCount: number;
  maxShellPool: number;
  peakActiveShells: number;
  scorchDecalPoolSize: number;
  maxBomberPool: number;
  trianglesPerAircraft: number;
}

export interface FireSupportSceneMetrics {
  fireSupportDrawCalls: number;
  fireSupportTriangles: number;
  activeShadowCasters: number;
}

export interface FireSupportBenchReport {
  tier: FireSupportBenchTier;
  rendererString: string;
  durationSec: number;
  framesSampled: number;
  cpuP95Ms: number;
  gpuP95Ms: number | 'SKIPPED_SOFTWARE_RENDERER' | 'FALLBACK_STRUCTURAL_PROXY';
  gpuWarning?: string;
  totalFrameP95Ms: number;
  peakAudioVoices: number;
  fireSupportDrawCalls: number;
  fireSupportTriangles: number;
  activeShadowCasters: number;
  poolInvariantsPassed: boolean;
  poolDetails: FireSupportPoolDetails;
  pass: boolean;
  failures: string[];
}

export interface EvaluateFireSupportBenchInput {
  rendererString: string;
  durationSec: number;
  framesSampled: number;
  cpuP95Ms: number;
  gpuTimerSamplesMs?: readonly number[] | null;
  gpuTimerAvailable: boolean;
  gpuTimerDisjoint?: boolean;
  totalFrameP95Ms: number;
  peakAudioVoices: number;
  fireSupportDrawCalls: number;
  fireSupportTriangles: number;
  activeShadowCasters: number;
  poolDetails: FireSupportPoolDetails;
  /** Optional sink for explicit warning on Tier B structural fallback (defaults to console.warn). */
  warnFn?: (message: string) => void;
}

/**
 * Classifies whether a WebGL renderer string corresponds to a CPU software rasterizer.
 */
export function detectSoftwareRenderer(rendererString: string): boolean {
  return SOFTWARE_RENDERER_REGEX.test(rendererString || '');
}

/**
 * Computes an upper-nearest-rank percentile (e.g., 0.95 for P95) from finite numeric samples.
 */
export function computePercentile(samples: readonly number[], percentile01: number): number {
  if (!samples || samples.length === 0) return 0;
  const clean: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    if (Number.isFinite(v) && v >= 0) clean.push(v);
  }
  if (clean.length === 0) return 0;
  clean.sort((a, b) => a - b);
  const clamped = Math.max(0, Math.min(1, percentile01));
  const idx = Math.min(clean.length - 1, Math.max(0, Math.ceil(clamped * clean.length) - 1));
  return Number(clean[idx].toFixed(3));
}

function isMaterialVisible(mat: THREE.Material | THREE.Material[]): boolean {
  if (Array.isArray(mat)) {
    for (let i = 0; i < mat.length; i++) {
      if (mat[i] && mat[i].visible !== false) return true;
    }
    return false;
  }
  return Boolean(mat && mat.visible !== false);
}

/**
 * Measures exact structural GPU proxy budgets across fire-support roots:
 *  - Draw calls: visible Mesh / InstancedMesh nodes with visible materials (matches WebGLRenderer draw list)
 *  - Triangles: exact indexed/non-indexed triangle count (multiplied by instance count for InstancedMesh)
 *  - Active shadow casters: visible Lights with castShadow === true across scene (or roots)
 */
export function measureFireSupportSceneMetrics(
  fireSupportRoots: readonly THREE.Object3D[],
  sceneForLights?: THREE.Object3D,
): FireSupportSceneMetrics {
  let fireSupportDrawCalls = 0;
  let fireSupportTriangles = 0;
  let activeShadowCasters = 0;

  const visitFireSupport = (obj: THREE.Object3D): void => {
    if (!obj.visible) return;
    if ((obj as THREE.InstancedMesh).isInstancedMesh) {
      const inst = obj as THREE.InstancedMesh;
      if (inst.count > 0 && isMaterialVisible(inst.material)) {
        fireSupportDrawCalls += 1;
        fireSupportTriangles += countGeometryTriangles(inst.geometry) * inst.count;
      }
    } else if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      if (isMaterialVisible(mesh.material)) {
        fireSupportDrawCalls += 1;
        fireSupportTriangles += countGeometryTriangles(mesh.geometry);
      }
    }
    const children = obj.children;
    for (let i = 0; i < children.length; i++) {
      visitFireSupport(children[i]);
    }
  };

  for (let i = 0; i < fireSupportRoots.length; i++) {
    visitFireSupport(fireSupportRoots[i]);
  }

  const seenLights = new Set<THREE.Object3D>();
  const visitLights = (obj: THREE.Object3D): void => {
    if (!obj.visible) return;
    if ((obj as THREE.Light).isLight && !seenLights.has(obj)) {
      seenLights.add(obj);
      if ((obj as THREE.Light).castShadow) {
        activeShadowCasters += 1;
      }
    }
    const children = obj.children;
    for (let i = 0; i < children.length; i++) {
      visitLights(children[i]);
    }
  };

  if (sceneForLights) {
    visitLights(sceneForLights);
  } else {
    for (let i = 0; i < fireSupportRoots.length; i++) {
      visitLights(fireSupportRoots[i]);
    }
  }

  return {
    fireSupportDrawCalls,
    fireSupportTriangles,
    activeShadowCasters,
  };
}

/**
 * Evaluates collected benchmark metrics against the Two-Tier RX 480 Performance Contract:
 *  - Tier A (Software Renderer): enforces CPU P95 <= 1.5ms, peak audio <= 12, pool invariants; marks GPU skipped.
 *  - Tier B (Hardware GPU with timer queries): enforces GPU P95 <= 1.0ms, CPU P95 <= 1.5ms, total frame P95 <= 16.6ms, audio <= 12, pool invariants.
 *  - Tier B (Hardware GPU without timer queries or disjoint): logs explicit warning, marks FALLBACK_STRUCTURAL_PROXY, and enforces hard structural ceilings (<= 28 draw calls, <= 18,000 tris, <= 1 shadow caster) + total frame P95 <= 16.6ms.
 */
export function evaluateFireSupportBenchReport(
  input: EvaluateFireSupportBenchInput,
): FireSupportBenchReport {
  const isSoftware = detectSoftwareRenderer(input.rendererString);
  const tier: FireSupportBenchTier = isSoftware ? 'TIER_A_SOFTWARE' : 'TIER_B_HARDWARE';
  const failures: string[] = [];

  const pool = input.poolDetails;
  const poolFailures: string[] = [];
  if (pool.pitCount > MAX_MORTAR_PITS) {
    poolFailures.push(`pitCount ${pool.pitCount} > ${MAX_MORTAR_PITS}`);
  }
  if (pool.maxShellPool !== MAX_MORTAR_SHELL_POOL) {
    poolFailures.push(`maxShellPool ${pool.maxShellPool} !== ${MAX_MORTAR_SHELL_POOL}`);
  }
  if (pool.peakActiveShells > MAX_MORTAR_SHELL_POOL) {
    poolFailures.push(`peakActiveShells ${pool.peakActiveShells} > ${MAX_MORTAR_SHELL_POOL}`);
  }
  if (pool.scorchDecalPoolSize !== MAX_SCORCH_DECAL_POOL) {
    poolFailures.push(`scorchDecalPoolSize ${pool.scorchDecalPoolSize} !== ${MAX_SCORCH_DECAL_POOL}`);
  }
  if (pool.maxBomberPool !== MAX_BOMBER_POOL) {
    poolFailures.push(`maxBomberPool ${pool.maxBomberPool} !== ${MAX_BOMBER_POOL}`);
  }
  if (pool.trianglesPerAircraft >= AIR_STRIKE_MAX_TRIANGLES_PER_AIRCRAFT) {
    poolFailures.push(
      `trianglesPerAircraft ${pool.trianglesPerAircraft} >= ${AIR_STRIKE_MAX_TRIANGLES_PER_AIRCRAFT}`,
    );
  }
  const poolInvariantsPassed = poolFailures.length === 0;
  for (let i = 0; i < poolFailures.length; i++) {
    failures.push(`POOL_INVARIANT: ${poolFailures[i]}`);
  }

  // Common invariants enforced on BOTH Tier A and Tier B
  if (input.cpuP95Ms > BENCH_CPU_P95_BUDGET_MS) {
    failures.push(
      `CPU_P95: ${input.cpuP95Ms.toFixed(3)}ms > ${BENCH_CPU_P95_BUDGET_MS}ms budget`,
    );
  }
  if (input.peakAudioVoices > FIRE_SUPPORT_MAX_VOICES) {
    failures.push(
      `AUDIO_VOICES: peak ${input.peakAudioVoices} > ${FIRE_SUPPORT_MAX_VOICES} hard cap`,
    );
  }

  let gpuP95Ms: FireSupportBenchReport['gpuP95Ms'] = 'SKIPPED_SOFTWARE_RENDERER';
  let gpuWarning: string | undefined;

  if (tier === 'TIER_A_SOFTWARE') {
    gpuP95Ms = 'SKIPPED_SOFTWARE_RENDERER';
  } else {
    // Tier B Hardware GPU
    if (input.totalFrameP95Ms > BENCH_TOTAL_FRAME_P95_BUDGET_MS) {
      failures.push(
        `TOTAL_FRAME_P95: ${input.totalFrameP95Ms.toFixed(2)}ms > ${BENCH_TOTAL_FRAME_P95_BUDGET_MS}ms (60 FPS budget)`,
      );
    }

    const hasValidTimerSamples =
      input.gpuTimerAvailable &&
      !input.gpuTimerDisjoint &&
      Array.isArray(input.gpuTimerSamplesMs) &&
      input.gpuTimerSamplesMs.length > 0;

    if (hasValidTimerSamples) {
      const measuredGpuP95 = computePercentile(input.gpuTimerSamplesMs!, 0.95);
      gpuP95Ms = measuredGpuP95;
      if (measuredGpuP95 > BENCH_GPU_P95_BUDGET_MS) {
        failures.push(
          `GPU_P95: ${measuredGpuP95.toFixed(3)}ms > ${BENCH_GPU_P95_BUDGET_MS}ms RX 480 budget`,
        );
      }
    } else {
      const warnReason = !input.gpuTimerAvailable
        ? 'EXT_disjoint_timer_query_webgl2 unavailable or disabled by browser privacy policy'
        : input.gpuTimerDisjoint
          ? 'EXT_disjoint_timer_query_webgl2 reported GPU_DISJOINT_EXT during sampling'
          : 'EXT_disjoint_timer_query_webgl2 returned zero completed query samples';

      gpuWarning =
        `[FireSupportPerfBenchmark] ${warnReason}; enforcing Tier B structural proxy ceilings ` +
        `(drawCalls <= ${BENCH_MAX_FIRE_SUPPORT_DRAW_CALLS}, tris <= ${BENCH_MAX_FIRE_SUPPORT_TRIANGLES}, ` +
        `shadowCasters <= ${BENCH_MAX_SHADOW_CASTERS}, frameP95 <= ${BENCH_TOTAL_FRAME_P95_BUDGET_MS}ms).`;

      const warnSink = input.warnFn ?? ((msg: string) => console.warn(msg));
      warnSink(gpuWarning);

      gpuP95Ms = 'FALLBACK_STRUCTURAL_PROXY';

      if (input.fireSupportDrawCalls > BENCH_MAX_FIRE_SUPPORT_DRAW_CALLS) {
        failures.push(
          `STRUCTURAL_DRAW_CALLS: ${input.fireSupportDrawCalls} > ${BENCH_MAX_FIRE_SUPPORT_DRAW_CALLS}`,
        );
      }
      if (input.fireSupportTriangles > BENCH_MAX_FIRE_SUPPORT_TRIANGLES) {
        failures.push(
          `STRUCTURAL_TRIANGLES: ${input.fireSupportTriangles} > ${BENCH_MAX_FIRE_SUPPORT_TRIANGLES}`,
        );
      }
      if (input.activeShadowCasters > BENCH_MAX_SHADOW_CASTERS) {
        failures.push(
          `STRUCTURAL_SHADOW_CASTERS: ${input.activeShadowCasters} > ${BENCH_MAX_SHADOW_CASTERS}`,
        );
      }
    }
  }

  return {
    tier,
    rendererString: input.rendererString,
    durationSec: Number(input.durationSec.toFixed(2)),
    framesSampled: input.framesSampled,
    cpuP95Ms: Number(input.cpuP95Ms.toFixed(3)),
    gpuP95Ms,
    ...(gpuWarning ? { gpuWarning } : {}),
    totalFrameP95Ms: Number(input.totalFrameP95Ms.toFixed(3)),
    peakAudioVoices: input.peakAudioVoices,
    fireSupportDrawCalls: input.fireSupportDrawCalls,
    fireSupportTriangles: input.fireSupportTriangles,
    activeShadowCasters: input.activeShadowCasters,
    poolInvariantsPassed,
    poolDetails: { ...pool },
    pass: failures.length === 0,
    failures,
  };
}

/**
 * Builds the canonical worst-case 6-pit Conquest site layout (2 HQ + 4 FOBs, all active).
 */
export function buildWorstCaseBenchMortarSites(): MortarSiteConfig[] {
  return [
    {
      pitId: 'bench_hq_a',
      ownerTeam: 'A',
      sourceType: 'HQ',
      sourceId: 'hq_a',
      position: [-190, 0, -25],
      zeroBearingRad: Math.PI * 0.5,
      active: true,
    },
    {
      pitId: 'bench_hq_b',
      ownerTeam: 'B',
      sourceType: 'HQ',
      sourceId: 'hq_b',
      position: [190, 0, 25],
      zeroBearingRad: Math.PI * 1.5,
      active: true,
    },
    {
      pitId: 'bench_fob_a1',
      ownerTeam: 'A',
      sourceType: 'FOB',
      sourceId: 'fob_a1',
      position: [-110, 0, -70],
      zeroBearingRad: Math.PI * 0.42,
      active: true,
    },
    {
      pitId: 'bench_fob_a2',
      ownerTeam: 'A',
      sourceType: 'FOB',
      sourceId: 'fob_a2',
      position: [-95, 0, 65],
      zeroBearingRad: Math.PI * 0.58,
      active: true,
    },
    {
      pitId: 'bench_fob_b1',
      ownerTeam: 'B',
      sourceType: 'FOB',
      sourceId: 'fob_b1',
      position: [110, 0, 70],
      zeroBearingRad: Math.PI * 1.42,
      active: true,
    },
    {
      pitId: 'bench_fob_b2',
      ownerTeam: 'B',
      sourceType: 'FOB',
      sourceId: 'fob_b2',
      position: [95, 0, -65],
      zeroBearingRad: Math.PI * 1.58,
      active: true,
    },
  ];
}

interface DisjointTimerQueryExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

function queryRendererString(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      const unmasked = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      if (typeof unmasked === 'string' && unmasked.trim().length > 0) {
        return unmasked.trim();
      }
    }
    const base = gl.getParameter(gl.RENDERER);
    if (typeof base === 'string' && base.trim().length > 0) {
      return base.trim();
    }
  } catch {
    // Fallback below
  }
  return 'Unknown WebGL Renderer';
}

export interface RunFireSupportBenchOptions {
  /** Stress run duration in seconds (default 10s). */
  durationSec?: number;
  /** Print structured JSON report to console when finished (default true). */
  logResult?: boolean;
}

/**
 * Executes the deterministic 10-second Two-Tier Conquest Fire Support worst-case stress benchmark:
 *  - 6 active mortar pits firing salvos
 *  - 1 active 5-round mortar sweep
 *  - 1 simultaneous bomber air strike (6 bombs + ground smoke flares + P0 Doppler roar)
 *
 * Dev-only harness; strictly gated behind `import.meta.env.DEV` in main.tsx.
 */
export async function runFireSupportPerfBenchmark(
  opts: RunFireSupportBenchOptions = {},
): Promise<FireSupportBenchReport> {
  const durationSec = Math.max(1, opts.durationSec ?? BENCH_DEFAULT_DURATION_SEC);
  const logResult = opts.logResult ?? true;

  if (typeof document === 'undefined') {
    throw new Error('[FireSupportPerfBenchmark] DOM/WebGL canvas is required to run WebGL benchmark.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
  });
  renderer.setSize(1280, 720, false);
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const gl = renderer.getContext();
  const rendererString = queryRendererString(gl);
  const isSoftware = detectSoftwareRenderer(rendererString);
  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const timerExt =
    !isSoftware && isWebGL2
      ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as DisjointTimerQueryExt | null)
      : null;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8899aa);

  const camera = new THREE.PerspectiveCamera(72, 1280 / 720, 0.25, 900);
  camera.position.set(0, 46, 125);
  camera.lookAt(0, 8, 0);

  // Single scene directional sun light (1 shadow caster ceiling)
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sun.position.set(90, 140, 70);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const hemi = new THREE.HemisphereLight(0xa8c2dd, 0x4b463d, 0.7);
  hemi.castShadow = false;
  scene.add(sun, hemi);

  const groundGeo = new THREE.PlaneGeometry(700, 700, 1, 1);
  groundGeo.rotateX(-Math.PI * 0.5);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x5c6252, roughness: 0.95 });
  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.receiveShadow = true;
  groundMesh.castShadow = false;
  scene.add(groundMesh);

  const audio = new BodycamAudio();
  const mortarSystem = new MortarEmplacementSystem({
    scene,
    audio,
    isHost: true,
    getGroundHeight: () => 0,
  });
  mortarSystem.configureSites(buildWorstCaseBenchMortarSites());

  const bomberSystem = new BomberAirStrikeSystem({
    scene,
    mortarSystem,
    audio,
    isHost: true,
    getGroundHeight: () => 0,
  });

  // Identify fire-support root groups attached to scene for isolated GPU timer pass & structural audit
  const fireSupportRoots: THREE.Object3D[] = [];
  for (let i = 0; i < scene.children.length; i++) {
    const child = scene.children[i];
    if (
      child.name === 'ConquestMortarEmplacements' ||
      child.name === 'ConquestBomberAirStrikes'
    ) {
      fireSupportRoots.push(child);
    }
  }

  const exclusions: MortarExclusionZone[] = [
    { x: -190, z: -25, radiusM: MORTAR_HQ_EXCLUSION_RADIUS_M, team: 'A', kind: 'hq' },
    { x: 190, z: 25, radiusM: MORTAR_HQ_EXCLUSION_RADIUS_M, team: 'B', kind: 'hq' },
  ];

  // Deterministic combatant targets so all 6 mortar pits actively engage
  const benchActors = [
    { id: 'bot_a1', team: 'A' as const, x: -35, y: 0, z: -12, alive: true },
    { id: 'bot_a2', team: 'A' as const, x: -18, y: 0, z: 24, alive: true },
    { id: 'bot_b1', team: 'B' as const, x: 32, y: 0, z: 14, alive: true },
    { id: 'bot_b2', team: 'B' as const, x: 18, y: 0, z: -28, alive: true },
  ];
  const localPlayerPos = new THREE.Vector3(0, 1.7, 30);

  // Trigger 1 active 5-round mortar sweep + 1 simultaneous bomber air strike at t = 0
  mortarSystem.requestMortarFireMission({
    callerId: 'bench_caller_a',
    callerName: 'BenchLead',
    callerTeam: 'A',
    targetX: 22,
    targetZ: -8,
    exclusionZones: exclusions,
    friendlyPositions: [{ x: -45, z: -10 }],
  });

  let strikeSeed = 0x51a4c0de;
  const triggerBenchAirStrike = (): void => {
    // Use alternating teams so 1 simultaneous bomber is guaranteed active across the full 10s run
    const team: 'A' | 'B' = (strikeSeed & 1) === 0 ? 'A' : 'B';
    bomberSystem.requestAirStrike({
      callerId: team === 'A' ? 'bench_caller_a' : 'bench_caller_b',
      callerName: team === 'A' ? 'EagleLead' : 'ViperLead',
      callerTeam: team,
      centerX: 8,
      centerZ: 0,
      headingRad: Math.PI * 0.35,
      sectorsHeld: 3,
      totalSectors: 5,
      exclusionZones: exclusions,
      friendlyPositions: [{ x: -60, z: 20 }],
      seed: strikeSeed++,
    });
  };
  triggerBenchAirStrike();

  const cpuSamplesMs: number[] = [];
  const totalFrameSamplesMs: number[] = [];
  const gpuSamplesMs: number[] = [];
  const pendingQueries: WebGLQuery[] = [];
  let gpuDisjoint = false;
  let peakAudioVoices = 0;
  let peakActiveShells = 0;
  let peakDrawCalls = 0;
  let peakTriangles = 0;
  let peakShadowCasters = 0;

  const pollPendingQueries = (): void => {
    if (!timerExt || !isWebGL2) return;
    const gl2 = gl as WebGL2RenderingContext;
    const disjoint = Boolean(gl2.getParameter(timerExt.GPU_DISJOINT_EXT));
    if (disjoint) {
      gpuDisjoint = true;
    }
    while (pendingQueries.length > 0) {
      const q = pendingQueries[0];
      const available = gl2.getQueryParameter(q, gl2.QUERY_RESULT_AVAILABLE);
      if (!available) break;
      pendingQueries.shift();
      if (!disjoint) {
        const ns = Number(gl2.getQueryParameter(q, gl2.QUERY_RESULT));
        if (Number.isFinite(ns) && ns >= 0) {
          gpuSamplesMs.push(ns / 1e6);
        }
      }
      gl2.deleteQuery(q);
    }
  };

  // Warmup 5 frames (shader compile + VBO upload excluded from steady-state P95)
  for (let w = 0; w < 5; w++) {
    mortarSystem.update(1 / 60, {
      localPlayerPos,
      targets: benchActors,
      exclusionZones: exclusions,
    });
    bomberSystem.update(1 / 60, { localPlayerTeam: 'A', localPlayerPos });
    renderer.render(scene, camera);
  }

  const startMs = performance.now();
  let lastFrameMs = startMs;
  let elapsedSec = 0;
  let framesSampled = 0;
  let retriggeredSecondWave = false;

  const stepOneFrame = (nowMs: number): void => {
    const rawFrameDeltaMs = Math.max(0.1, nowMs - lastFrameMs);
    lastFrameMs = nowMs;
    const simDt = Math.min(0.05, Math.max(1 / 120, rawFrameDeltaMs / 1000));
    elapsedSec = (nowMs - startMs) / 1000;

    // Keep worst-case overlap hot across the entire 10s window
    if (!retriggeredSecondWave && elapsedSec >= 6.4) {
      retriggeredSecondWave = true;
      triggerBenchAirStrike();
      mortarSystem.requestMortarFireMission({
        callerId: 'bench_caller_b',
        callerName: 'BenchBravo',
        callerTeam: 'B',
        targetX: -22,
        targetZ: 10,
        exclusionZones: exclusions,
        friendlyPositions: [{ x: 60, z: 10 }],
      });
    }

    // Measure pure fire-support CPU tick cost
    const cpuStart = performance.now();
    mortarSystem.update(simDt, {
      localPlayerPos,
      targets: benchActors,
      exclusionZones: exclusions,
    });
    bomberSystem.update(simDt, { localPlayerTeam: 'A', localPlayerPos });
    const cpuMs = performance.now() - cpuStart;
    cpuSamplesMs.push(cpuMs);
    totalFrameSamplesMs.push(rawFrameDeltaMs);

    // Track peak runtime pools & audio voices
    const mDiag = mortarSystem.getDiagnostics();
    if (mDiag.activeShells > peakActiveShells) {
      peakActiveShells = mDiag.activeShells;
    }
    const voiceCount = audio.getFireSupportActiveVoiceCount();
    if (voiceCount > peakAudioVoices) {
      peakAudioVoices = voiceCount;
    }

    // Sample structural draw calls / triangles / shadow casters every 15 frames
    if (framesSampled % 15 === 0) {
      const metrics = measureFireSupportSceneMetrics(fireSupportRoots, scene);
      if (metrics.fireSupportDrawCalls > peakDrawCalls) peakDrawCalls = metrics.fireSupportDrawCalls;
      if (metrics.fireSupportTriangles > peakTriangles) peakTriangles = metrics.fireSupportTriangles;
      if (metrics.activeShadowCasters > peakShadowCasters) peakShadowCasters = metrics.activeShadowCasters;
    }

    // Render frame (bracketing fire-support pass with EXT_disjoint_timer_query_webgl2 when available)
    if (timerExt && isWebGL2) {
      const gl2 = gl as WebGL2RenderingContext;
      pollPendingQueries();

      // Pass 1: base environment (terrain + lighting)
      for (let i = 0; i < fireSupportRoots.length; i++) fireSupportRoots[i].visible = false;
      groundMesh.visible = true;
      renderer.autoClear = true;
      renderer.render(scene, camera);

      // Pass 2: isolated fire-support pass bracketed by GPU timer query (retaining terrain depth)
      groundMesh.visible = false;
      for (let i = 0; i < fireSupportRoots.length; i++) fireSupportRoots[i].visible = true;
      renderer.autoClear = false;
      const q = gl2.createQuery();
      if (q) {
        gl2.beginQuery(timerExt.TIME_ELAPSED_EXT, q);
        renderer.render(scene, camera);
        gl2.endQuery(timerExt.TIME_ELAPSED_EXT);
        pendingQueries.push(q);
      } else {
        renderer.render(scene, camera);
      }
      groundMesh.visible = true;
      renderer.autoClear = true;
    } else {
      renderer.render(scene, camera);
    }

    framesSampled++;
  };

  // Drive loop with requestAnimationFrame to measure real browser frame pacing
  await new Promise<void>((resolve) => {
    const raf =
      typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame.bind(window)
        : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16);

    const tick = (nowMs: number): void => {
      stepOneFrame(nowMs);
      if ((nowMs - startMs) / 1000 < durationSec) {
        raf(tick);
      } else {
        resolve();
      }
    };
    raf(tick);
  });

  // Final poll for completed GPU queries & cleanup any stragglers
  if (timerExt && isWebGL2) {
    const gl2 = gl as WebGL2RenderingContext;
    gl2.flush();
    pollPendingQueries();
    while (pendingQueries.length > 0) {
      const q = pendingQueries.shift();
      if (q) gl2.deleteQuery(q);
    }
  }

  // Final structural audit snapshot
  const finalMetrics = measureFireSupportSceneMetrics(fireSupportRoots, scene);
  peakDrawCalls = Math.max(peakDrawCalls, finalMetrics.fireSupportDrawCalls);
  peakTriangles = Math.max(peakTriangles, finalMetrics.fireSupportTriangles);
  peakShadowCasters = Math.max(peakShadowCasters, finalMetrics.activeShadowCasters);

  const mDiag = mortarSystem.getDiagnostics();
  const bDiag = bomberSystem.getDiagnostics();

  const report = evaluateFireSupportBenchReport({
    rendererString,
    durationSec: (performance.now() - startMs) / 1000,
    framesSampled,
    cpuP95Ms: computePercentile(cpuSamplesMs, 0.95),
    gpuTimerSamplesMs: gpuSamplesMs,
    gpuTimerAvailable: Boolean(timerExt),
    gpuTimerDisjoint: gpuDisjoint,
    totalFrameP95Ms: computePercentile(totalFrameSamplesMs, 0.95),
    peakAudioVoices,
    fireSupportDrawCalls: peakDrawCalls,
    fireSupportTriangles: peakTriangles,
    activeShadowCasters: peakShadowCasters,
    poolDetails: {
      pitCount: mDiag.pitCount,
      maxShellPool: mDiag.maxShellPool,
      peakActiveShells,
      scorchDecalPoolSize: mDiag.scorchDecalPoolSize,
      maxBomberPool: bDiag.maxPoolSize,
      trianglesPerAircraft: bDiag.trianglesPerAircraft,
    },
  });

  // Dispose all benchmark resources cleanly
  bomberSystem.dispose();
  mortarSystem.dispose();
  audio.dispose();
  groundGeo.dispose();
  groundMat.dispose();
  renderer.dispose();

  if (logResult) {
    console.info('[FireSupportPerfBenchmark] Report:', JSON.stringify(report, null, 2));
  }

  return report;
}

declare global {
  interface Window {
    __AXON_DEV_PERF_BENCH__?: (
      opts?: RunFireSupportBenchOptions,
    ) => Promise<FireSupportBenchReport>;
  }
}

/**
 * Installs dev-only global benchmark trigger (`window.__AXON_DEV_PERF_BENCH__`) and
 * auto-executes when `?bench=fire_support` is present in the URL.
 * Caller MUST guard invocation with `if (import.meta.env.DEV)`.
 */
export function installDevFireSupportBenchGlobal(): void {
  if (typeof window === 'undefined') return;
  window.__AXON_DEV_PERF_BENCH__ = runFireSupportPerfBenchmark;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('bench') === 'fire_support') {
      void runFireSupportPerfBenchmark({ durationSec: BENCH_DEFAULT_DURATION_SEC, logResult: true });
    }
  } catch {
    // Ignore malformed query strings
  }
}

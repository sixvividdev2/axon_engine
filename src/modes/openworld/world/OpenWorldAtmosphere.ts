import * as THREE from 'three';
import type { OpenWorldWeatherId } from '../types';
import {
  type AtmoFogSharedUniforms,
  createAtmoFogSharedUniforms,
} from './OpenWorldAtmosphericFogShader';

/**
 * Full 24-hour world cycle spans 90 real-time minutes (5,400 seconds) per specification.
 */
export const OPENWORLD_DAY_CYCLE_SECONDS = 5400; // 90 minutes

const OCCLUSION_SKY_LAYER = 3;
const CLOUD_DECK_COUNT = 88;
const CLOUD_WRAP_SPAN_M = 4200;

export interface AtmosphereTelemetry {
  timeOfDayHours: number; // 0..24
  timeFormatted: string; // HH:MM
  phaseLabel: 'Dawn' | 'Daylight' | 'Dusk' | 'Night Ops';
  weather: OpenWorldWeatherId;
  weatherLabel: string;
  sunElevationDeg: number;
  ambientLux: number; // 0..1
  aiVisionConeMultiplier: number; // 0.25..1.0
  visibilityMeters: number;
  nightOpsActive: boolean;
  timeScale: number;
  autoWeatherCycle: boolean;
  cloudCoveragePct: number;
  godraysActive: boolean;
}

interface WeatherPresetParams {
  baseFog: number;
  valleyMist: number;
  heightFalloff: number;
  overcast: number;
  cloudCoverage: number;
  cirrusCoverage: number;
  rainAlpha: number;
  weatherVisMult: number;
  godrayScale: number;
  inscatterStrength: number;
}

const WEATHER_PRESETS: Readonly<Record<OpenWorldWeatherId, WeatherPresetParams>> = {
  clear: {
    baseFog: 0.00034,
    valleyMist: 0.00095,
    heightFalloff: 0.025,
    overcast: 0.06,
    cloudCoverage: 0.42,
    cirrusCoverage: 0.46,
    rainAlpha: 0.0,
    weatherVisMult: 1.0,
    godrayScale: 1.0,
    inscatterStrength: 0.56,
  },
  coastal_fog: {
    baseFog: 0.00188,
    valleyMist: 0.0052,
    heightFalloff: 0.021,
    overcast: 0.56,
    cloudCoverage: 0.72,
    cirrusCoverage: 0.64,
    rainAlpha: 0.0,
    weatherVisMult: 0.52,
    godrayScale: 0.58,
    inscatterStrength: 0.74,
  },
  mountain_rain: {
    baseFog: 0.00142,
    valleyMist: 0.00235,
    heightFalloff: 0.014,
    overcast: 0.82,
    cloudCoverage: 0.94,
    cirrusCoverage: 0.88,
    rainAlpha: 0.56,
    weatherVisMult: 0.68,
    godrayScale: 0.22,
    inscatterStrength: 0.26,
  },
};

const WEATHER_CYCLE_ORDER: readonly OpenWorldWeatherId[] = [
  'clear',
  'coastal_fog',
  'clear',
  'mountain_rain',
];

const WEATHER_LABELS: Readonly<Record<OpenWorldWeatherId, string>> = {
  clear: 'Clear',
  coastal_fog: 'Coastal Fog',
  mountain_rain: 'Mountain Rain',
};

// Module-scope zero-GC scratch objects
const _skyZenith = new THREE.Color();
const _skyHorizon = new THREE.Color();
const _fogColor = new THREE.Color();
const _inscatterColor = new THREE.Color();
const _sunColor = new THREE.Color();
const _hemiSky = new THREE.Color();
const _hemiGround = new THREE.Color();
const _cloudLitColor = new THREE.Color();
const _cloudShadeColor = new THREE.Color();
const _godrayTintColor = new THREE.Color();
const _blackColor = new THREE.Color(0x000000);

const _sunDir = new THREE.Vector3();
const _moonDir = new THREE.Vector3();
const _camForward = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _lightWorldPos = new THREE.Vector3();
const _projectedNdc = new THREE.Vector3();
const _sizeVec = new THREE.Vector2();

const _dayZenith = new THREE.Color(0x21528c);
const _dayHorizon = new THREE.Color(0x9fc0de);
const _duskZenith = new THREE.Color(0x1a2548);
const _duskHorizon = new THREE.Color(0xe0824a);
const _nightZenith = new THREE.Color(0x040813);
const _nightHorizon = new THREE.Color(0x101c33);
const _fogOvercast = new THREE.Color(0x74828d);
const _rainOvercast = new THREE.Color(0x3a4552);

const _daySunColor = new THREE.Color(0xfff1dc);
const _duskSunColor = new THREE.Color(0xff9248);
const _moonColor = new THREE.Color(0x8db0e6);
const _dayInscatter = new THREE.Color(0xffdfb8);
const _duskInscatter = new THREE.Color(0xff9f5c);
const _nightInscatter = new THREE.Color(0x2d4975);

const SKY_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorldDir;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldDir = normalize(position);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SKY_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uZenithColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uInscatterColor;
  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform vec3 uSunColor;
  uniform float uSunIntensity;
  uniform float uNightFactor;
  uniform float uOvercast;
  uniform float uCirrusCoverage;
  uniform float uCloudDrift;
  uniform float uOcclusionPass;
  varying vec3 vWorldDir;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float starHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float cirrusFbm(vec2 p) {
    float v = 0.0;
    float a = 0.52;
    mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
    for (int i = 0; i < 4; i++) {
      v += a * valueNoise(p);
      p = rot * p * 2.08 + vec2(7.3, 13.1);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    vec3 dir = normalize(vWorldDir);
    float up = clamp(dir.y, 0.0, 1.0);

    vec3 sunN = normalize(uSunDir);
    vec3 moonN = normalize(uMoonDir);
    float sunDot = max(dot(dir, sunN), 0.0);
    float moonDot = max(dot(dir, moonN), 0.0);

    // High-altitude procedural cirrus shell (curved dome projection)
    float cirrusMask = 0.0;
    if (dir.y > 0.005) {
      vec2 skyUv = dir.xz / (dir.y + 0.22);
      vec2 windUv = skyUv * 0.68 + vec2(uCloudDrift * 0.012, uCloudDrift * 0.0045);
      float n1 = cirrusFbm(windUv * vec2(1.4, 0.72));
      float n2 = cirrusFbm(windUv * vec2(2.6, 1.8) - vec2(uCloudDrift * 0.006, 0.0));
      float rawCirrus = n1 * 0.7 + n2 * 0.3;
      float threshold = mix(0.68, 0.34, clamp(uCirrusCoverage, 0.0, 1.0));
      cirrusMask = smoothstep(threshold, threshold + 0.28, rawCirrus) * smoothstep(0.01, 0.22, up);
    }

    // Dedicated occlusion emitter pass for screen-space radial godrays
    if (uOcclusionPass > 0.5) {
      float cloudBlock = clamp(cirrusMask * 0.72 + uOvercast * 0.45, 0.0, 0.92);
      float corona = (pow(sunDot, 22.0) * 0.42 + smoothstep(0.9965, 0.9994, sunDot) * 1.4) * uSunIntensity;
      vec3 emitCol = uSunColor * corona * (1.0 - cloudBlock);
      gl_FragColor = vec4(emitCol, 1.0);
      return;
    }

    // Rayleigh & ozone vertical atmospheric curve
    float horizonPow = pow(1.0 - up, 2.65);
    float midBand = pow(1.0 - up, 1.25) * 0.28;
    vec3 col = mix(uZenithColor, uHorizonColor, clamp(horizonPow + midBand * 0.35, 0.0, 1.0));

    // Mie forward-scattering horizon glow around sun
    float horizonMie = pow(sunDot, 4.5) * pow(1.0 - up, 1.9) * (0.45 + uOvercast * 0.2);
    col = mix(col, uInscatterColor, clamp(horizonMie * (1.0 - uNightFactor * 0.78), 0.0, 0.75));

    // Solar aureole + corona + crisp sun disc (or lunar disc when night)
    float clearFactor = 1.0 - clamp(uOvercast * 0.78 + cirrusMask * 0.38, 0.0, 0.94);
    float aureole = pow(sunDot, 12.0) * 0.34 * uSunIntensity * (1.0 - uOvercast * 0.65);
    float innerCorona = pow(sunDot, 96.0) * 0.85 * uSunIntensity * clearFactor;
    float sunDisc = smoothstep(0.9986, 0.9995, sunDot) * 2.1 * uSunIntensity * clearFactor;
    col += uSunColor * (aureole + innerCorona + sunDisc);

    // Subtle moon disc & cool atmospheric halo at night
    if (uNightFactor > 0.12 && moonN.y > -0.05) {
      float moonHalo = pow(moonDot, 28.0) * 0.22 * uNightFactor * (1.0 - uOvercast * 0.75);
      float moonDisc = smoothstep(0.9991, 0.9996, moonDot) * 1.15 * uNightFactor * (1.0 - uOvercast * 0.85);
      col += vec3(0.68, 0.82, 1.0) * (moonHalo + moonDisc);
    }

    // Crisp multi-scale night starfield (masked behind clouds & horizon mist)
    if (uNightFactor > 0.15 && up > 0.06 && uOvercast < 0.72) {
      vec3 grid = floor(dir * 270.0);
      float h = starHash(grid);
      float twinkle = 0.82 + 0.18 * sin(uCloudDrift * 1.7 + h * 90.0);
      float starVis = (1.0 - clamp(cirrusMask * 0.9 + uOvercast * 0.9, 0.0, 1.0));
      float star = smoothstep(0.9964, 0.9996, h) * uNightFactor * starVis * smoothstep(0.06, 0.34, up);
      col += vec3(0.84, 0.91, 1.0) * star * twinkle * 0.95;
    }

    // Blend wispy sunlit / moonlit cirrus & altostratus bands into sky dome
    if (cirrusMask > 0.002) {
      vec3 cirrusSunLit = mix(uHorizonColor * 1.12 + vec3(0.28), uSunColor * 1.15, clamp(pow(sunDot, 3.0) * 0.7 + 0.25, 0.0, 1.0));
      vec3 cirrusNightLit = uHorizonColor * 1.35 + vec3(0.08, 0.11, 0.17);
      vec3 cirrusShade = mix(cirrusSunLit, cirrusNightLit, uNightFactor);
      cirrusShade = mix(cirrusShade, uHorizonColor * 0.76, uOvercast * 0.65);
      col = mix(col, cirrusShade, clamp(cirrusMask * (0.48 + uOvercast * 0.36), 0.0, 0.88));
    }

    // Lower hemisphere blends cleanly into fog horizon color so horizon seams never show
    if (dir.y < 0.0) {
      col = mix(col, uHorizonColor, smoothstep(0.0, -0.14, dir.y));
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

const CLOUD_DECK_VERTEX_SHADER = /* glsl */ `
  attribute vec4 aCloudUvRect;
  attribute vec4 aCloudParams; // x: baseX, y: altY, z: baseZ, w: sizeScale

  uniform vec3 uCameraAnchor;
  uniform vec3 uCamRight;
  uniform vec3 uCamUp;
  uniform float uCloudDrift;
  uniform float uWrapSpan;

  varying vec2 vAtlasUv;
  varying vec2 vLocalUv;
  varying float vDistAlpha;
  varying vec3 vCloudWorldPos;

  void main() {
    float halfSpan = uWrapSpan * 0.5;
    float driftedX = aCloudParams.x + uCloudDrift * (6.5 + mod(aCloudParams.w, 3.0) * 1.8);
    float driftedZ = aCloudParams.z + uCloudDrift * 2.2;

    float relX = mod(driftedX - uCameraAnchor.x + halfSpan, uWrapSpan) - halfSpan;
    float relZ = mod(driftedZ - uCameraAnchor.z + halfSpan, uWrapSpan) - halfSpan;

    vec3 centerWorld = vec3(uCameraAnchor.x + relX, aCloudParams.y, uCameraAnchor.z + relZ);
    float width = 340.0 * aCloudParams.w;
    float height = 135.0 * aCloudParams.w;

    // Soft camera-facing cylindrical billboard (keeps upright silhouettes)
    vec3 rightVec = normalize(vec3(uCamRight.x, 0.0, uCamRight.z) + vec3(0.0001, 0.0, 0.0));
    vec3 upVec = mix(vec3(0.0, 1.0, 0.0), uCamUp, 0.35);

    vec3 worldPos = centerWorld + rightVec * (position.x * width) + upVec * (position.y * height);
    vCloudWorldPos = worldPos;
    vLocalUv = uv;
    vAtlasUv = aCloudUvRect.xy + uv * aCloudUvRect.zw;

    float horizDist = length(vec2(relX, relZ));
    vDistAlpha = (1.0 - smoothstep(halfSpan * 0.68, halfSpan * 0.96, horizDist))
               * smoothstep(140.0, 320.0, horizDist);

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);
  }
`;

const CLOUD_DECK_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D tCloudAtlas;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uCloudLitColor;
  uniform vec3 uCloudShadeColor;
  uniform vec3 uHorizonColor;
  uniform float uCloudOpacity;
  uniform float uOcclusionPass;

  varying vec2 vAtlasUv;
  varying vec2 vLocalUv;
  varying float vDistAlpha;
  varying vec3 vCloudWorldPos;

  void main() {
    vec4 tex = texture2D(tCloudAtlas, vAtlasUv);
    float alpha = tex.a * uCloudOpacity * vDistAlpha;
    if (alpha < 0.015) discard;

    // During screen-space godray occlusion pass, 3D clouds carve crisp silhouettes out of sunbeams
    if (uOcclusionPass > 0.5) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, clamp(alpha * 1.35, 0.0, 1.0));
      return;
    }

    vec3 viewDir = normalize(vCloudWorldPos - cameraPosition);
    float sunAlign = max(dot(viewDir, normalize(uSunDir)), 0.0);
    float silverLining = pow(sunAlign, 10.0) * 0.62 * (1.0 - tex.a * 0.45);

    // Top-lit cumulus shading combined with baked procedural puff luminance
    float heightLit = clamp(vLocalUv.y * 0.72 + tex.r * 0.45, 0.0, 1.0);
    vec3 col = mix(uCloudShadeColor, uCloudLitColor, heightLit);
    col += uSunColor * silverLining;

    // Gentle aerial horizon dissolve so far clouds merge cleanly into sky haze
    float camDist = length(vCloudWorldPos - cameraPosition);
    float horizonFade = smoothstep(800.0, 2250.0, camDist) * 0.55;
    col = mix(col, uHorizonColor, horizonFade);

    gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.94));
  }
`;

const GODRAY_SCATTER_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const GODRAY_SCATTER_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D tOcclusion;
  uniform vec2 uSunScreenUv;
  uniform float uDensity;
  uniform float uDecay;
  uniform float uWeight;
  uniform float uExposure;

  varying vec2 vUv;

  float ditherNoise(vec2 uv) {
    return fract(sin(dot(uv, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec2 deltaTexCoord = (vUv - uSunScreenUv) * (uDensity / 16.0);
    float jitter = ditherNoise(gl_FragCoord.xy);
    vec2 coord = vUv - deltaTexCoord * jitter;

    float illuminationDecay = 1.0;
    vec3 accum = vec3(0.0);

    for (int i = 0; i < 16; i++) {
      coord -= deltaTexCoord;
      vec2 clampedCoord = clamp(coord, vec2(0.002), vec2(0.998));
      vec3 s = texture2D(tOcclusion, clampedCoord).rgb;
      s *= illuminationDecay * uWeight;
      accum += s;
      illuminationDecay *= uDecay;
    }

    // Soft radial vignette so screen edges never show abrupt cutoff
    float edgeDist = length(vUv - uSunScreenUv);
    float radialAtten = 1.0 - smoothstep(0.45, 1.35, edgeDist);
    gl_FragColor = vec4(accum * uExposure * radialAtten, 1.0);
  }
`;

const GODRAY_COMPOSITE_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.9999, 1.0);
  }
`;

const GODRAY_COMPOSITE_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D tGodrays;
  uniform vec3 uGodrayTint;
  uniform float uStrength;
  varying vec2 vUv;
  void main() {
    vec3 ray = texture2D(tGodrays, vUv).rgb * uGodrayTint * uStrength;
    gl_FragColor = vec4(ray, 1.0);
  }
`;

/**
 * Generates a deterministic 256×256 2×2 atlas of multi-lobe volumetric cumulus puffs
 * in pure RGBA bytes (zero HTML Canvas or external asset dependencies; runs in browser and Node tests).
 */
function createProceduralCloudAtlasTexture(): THREE.DataTexture {
  const size = 256;
  const half = size / 2;
  const data = new Uint8Array(size * size * 4);

  const cellConfigs = [
    [
      { cx: 0.50, cy: 0.48, rx: 0.24, ry: 0.19, w: 1.0 },
      { cx: 0.34, cy: 0.56, rx: 0.20, ry: 0.14, w: 0.85 },
      { cx: 0.67, cy: 0.56, rx: 0.19, ry: 0.15, w: 0.88 },
      { cx: 0.45, cy: 0.36, rx: 0.16, ry: 0.15, w: 0.78 },
    ],
    [
      { cx: 0.46, cy: 0.50, rx: 0.25, ry: 0.18, w: 1.0 },
      { cx: 0.64, cy: 0.45, rx: 0.18, ry: 0.17, w: 0.92 },
      { cx: 0.29, cy: 0.57, rx: 0.17, ry: 0.13, w: 0.80 },
      { cx: 0.54, cy: 0.35, rx: 0.14, ry: 0.14, w: 0.72 },
    ],
    [
      { cx: 0.52, cy: 0.52, rx: 0.27, ry: 0.17, w: 0.96 },
      { cx: 0.36, cy: 0.43, rx: 0.18, ry: 0.16, w: 0.88 },
      { cx: 0.68, cy: 0.57, rx: 0.18, ry: 0.13, w: 0.82 },
      { cx: 0.48, cy: 0.34, rx: 0.14, ry: 0.13, w: 0.70 },
    ],
    [
      { cx: 0.49, cy: 0.51, rx: 0.26, ry: 0.18, w: 1.0 },
      { cx: 0.31, cy: 0.53, rx: 0.18, ry: 0.15, w: 0.86 },
      { cx: 0.66, cy: 0.49, rx: 0.19, ry: 0.16, w: 0.90 },
      { cx: 0.55, cy: 0.37, rx: 0.15, ry: 0.14, w: 0.76 },
    ],
  ];

  for (let py = 0; py < size; py++) {
    const qy = py < half ? 0 : 1;
    const ly = (py - qy * half) / half;
    for (let px = 0; px < size; px++) {
      const qx = px < half ? 0 : 1;
      const lx = (px - qx * half) / half;
      const variantIdx = qy * 2 + qx;
      const lobes = cellConfigs[variantIdx];

      let density = 0;
      for (let k = 0; k < lobes.length; k++) {
        const l = lobes[k];
        const dx = (lx - l.cx) / l.rx;
        const dy = (ly - l.cy) / l.ry;
        const d2 = dx * dx + dy * dy;
        if (d2 < 1.0) {
          const lobeVal = Math.pow(1.0 - d2, 1.45) * l.w;
          if (lobeVal > density) density = lobeVal;
          else density = Math.min(1.0, density + lobeVal * 0.32);
        }
      }

      // Deterministic billow micro-detail
      const billow =
        0.86 +
        0.14 *
          (Math.sin(lx * 24.0 + variantIdx * 2.1) * Math.cos(ly * 21.0 - variantIdx * 1.7));
      const flatBottom = Math.min(1.0, Math.max(0.0, (0.82 - ly) * 3.8));
      const alpha = Math.min(1.0, Math.max(0.0, density * billow * flatBottom * 1.18));

      // Luminance channel (top puffs brighter, cloud base softer)
      const shade = Math.min(1.0, Math.max(0.35, 0.52 + (1.0 - ly) * 0.42 + density * 0.18));
      const lumByte = Math.round(shade * 255);
      const alphaByte = Math.round(alpha * 255);
      const idx = (py * size + px) * 4;
      data[idx] = lumByte;
      data[idx + 1] = lumByte;
      data[idx + 2] = lumByte;
      data[idx + 3] = alphaByte;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Dynamic 90-minute Day/Night Cycle, Rayleigh/Mie Skybox, Hybrid 3D Clouds + Cirrus Dome,
 * Height-Based Valley Mist, Sun-Inscatter Distance Fog & Screen-Space Radial Occlusion Godrays.
 * - Zero per-frame heap allocations.
 * - Dynamically scales `aiVisionConeMultiplier`, fog density, sky shader, and shadow-casting sun/moon.
 */
export class OpenWorldAtmosphere {
  public readonly sunLight: THREE.DirectionalLight;
  public readonly hemiLight: THREE.HemisphereLight;
  public readonly skyDome: THREE.Mesh;
  public readonly fog: THREE.FogExp2;
  public readonly fogUniforms: AtmoFogSharedUniforms;

  private readonly scene: THREE.Scene;
  private readonly isSoftwareGl: boolean;
  private readonly skyMaterial: THREE.ShaderMaterial;

  // Hybrid 3D Cloud Deck (1-draw-call InstancedMesh wrapped seamlessly around player)
  private readonly cloudAtlasTex: THREE.DataTexture;
  private readonly cloudDeckMat: THREE.ShaderMaterial;
  private readonly cloudDeckMesh: THREE.InstancedMesh;

  // Rain Curtain
  private readonly rainPoints: THREE.Points;
  private readonly rainPositions: Float32Array;
  private readonly rainCount = 900;

  // Screen-Space Radial Occlusion Godrays (GPU hardware path)
  private occlusionRt: THREE.WebGLRenderTarget | null = null;
  private godrayRt: THREE.WebGLRenderTarget | null = null;
  private occluderBlackMat: THREE.MeshBasicMaterial | null = null;
  private godrayBlurScene: THREE.Scene | null = null;
  private godrayBlurCamera: THREE.OrthographicCamera | null = null;
  private godrayScatterMat: THREE.ShaderMaterial | null = null;
  private godrayCompositeMat: THREE.ShaderMaterial | null = null;
  private godrayCompositeQuad: THREE.Mesh | null = null;
  private godraysAllowedForPass = true;
  private godraysVisibleThisFrame = false;

  private timeOfDayHours = 9.5; // Crisp morning start
  private weather: OpenWorldWeatherId = 'clear';
  private timeScale = 1; // 1 = real 90-minute 24h cycle
  private paused = false;
  private currentNightFactor = 0;
  private cloudDriftSeconds = 0;

  // Smooth weather crossfade state & optional autonomous weather cycling
  private autoWeatherCycle = false;
  private autoCycleIndex = 0;
  private autoCycleTimerSec = 260;
  private crossfadeRate = 0.25;
  private curBaseFog = WEATHER_PRESETS.clear.baseFog;
  private curValleyMist = WEATHER_PRESETS.clear.valleyMist;
  private curHeightFalloff = WEATHER_PRESETS.clear.heightFalloff;
  private curOvercast = WEATHER_PRESETS.clear.overcast;
  private curCloudCoverage = WEATHER_PRESETS.clear.cloudCoverage;
  private curCirrusCoverage = WEATHER_PRESETS.clear.cirrusCoverage;
  private curRainAlpha = WEATHER_PRESETS.clear.rainAlpha;
  private curWeatherVisMult = WEATHER_PRESETS.clear.weatherVisMult;
  private curGodrayScale = WEATHER_PRESETS.clear.godrayScale;
  private curInscatterStrength = WEATHER_PRESETS.clear.inscatterStrength;

  private readonly telemetry: AtmosphereTelemetry = {
    timeOfDayHours: 9.5,
    timeFormatted: '09:30',
    phaseLabel: 'Daylight',
    weather: 'clear',
    weatherLabel: 'Clear',
    sunElevationDeg: 40,
    ambientLux: 0.85,
    aiVisionConeMultiplier: 1.0,
    visibilityMeters: 2400,
    nightOpsActive: false,
    timeScale: 1,
    autoWeatherCycle: false,
    cloudCoveragePct: 42,
    godraysActive: false,
  };

  constructor(scene: THREE.Scene, isSoftwareGl: boolean) {
    this.scene = scene;
    this.isSoftwareGl = isSoftwareGl;
    this.fogUniforms = createAtmoFogSharedUniforms();

    this.fog = new THREE.FogExp2(0x9ab8d4, this.curBaseFog);
    this.scene.fog = this.fog;
    this.scene.background = _fogColor.clone();

    // Warm sun / cool moon directional key light
    this.sunLight = new THREE.DirectionalLight(0xfff1dc, 2.2);
    this.sunLight.castShadow = !isSoftwareGl;
    if (!isSoftwareGl) {
      this.sunLight.shadow.mapSize.set(2048, 2048);
      this.sunLight.shadow.camera.near = 20;
      this.sunLight.shadow.camera.far = 420;
      const d = 135;
      this.sunLight.shadow.camera.left = -d;
      this.sunLight.shadow.camera.right = d;
      this.sunLight.shadow.camera.top = d;
      this.sunLight.shadow.camera.bottom = -d;
      this.sunLight.shadow.bias = -0.0005;
      this.sunLight.shadow.normalBias = 0.03;
    }
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // Sky/ground hemisphere fill
    this.hemiLight = new THREE.HemisphereLight(0x9dc2e6, 0x3b3d32, 0.85);
    this.scene.add(this.hemiLight);

    // Procedural Rayleigh/Mie + Cirrus Dome (follows camera position, zero depth write)
    const skyGeo = new THREE.SphereGeometry(4800, 32, 20);
    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: SKY_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenithColor: { value: _dayZenith.clone() },
        uHorizonColor: { value: _dayHorizon.clone() },
        uInscatterColor: { value: _dayInscatter.clone() },
        uSunDir: { value: new THREE.Vector3(0.4, 0.7, -0.45).normalize() },
        uMoonDir: { value: new THREE.Vector3(-0.4, -0.7, 0.45).normalize() },
        uSunColor: { value: _daySunColor.clone() },
        uSunIntensity: { value: 1.0 },
        uNightFactor: { value: 0.0 },
        uOvercast: { value: 0.06 },
        uCirrusCoverage: { value: 0.46 },
        uCloudDrift: { value: 0.0 },
        uOcclusionPass: { value: 0.0 },
      },
    });
    this.skyDome = new THREE.Mesh(skyGeo, this.skyMaterial);
    this.skyDome.frustumCulled = false;
    this.skyDome.renderOrder = -10;
    this.skyDome.layers.enable(OCCLUSION_SKY_LAYER);
    this.scene.add(this.skyDome);

    // Hybrid 3D Cloud Deck Cards (1-draw-call InstancedMesh drifting across two strata)
    this.cloudAtlasTex = createProceduralCloudAtlasTexture();
    const cardGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
    const uvRects = new Float32Array(CLOUD_DECK_COUNT * 4);
    const params = new Float32Array(CLOUD_DECK_COUNT * 4);

    // Deterministic golden-angle / stratified placement for natural 3D parallax
    for (let i = 0; i < CLOUD_DECK_COUNT; i++) {
      const rx = ((i * 0.6180339887) % 1.0) - 0.5;
      const rz = (((i * 0.3819660113) + Math.floor(i / 11) * 0.13) % 1.0) - 0.5;
      const stratum = i % 3 === 0 ? 780 : i % 2 === 0 ? 590 : 450;
      const altJitter = ((i * 37) % 110) - 45;
      const scale = (i % 3 === 0 ? 1.45 : 1.05) + ((i * 19) % 10) * 0.09;

      params[i * 4] = rx * CLOUD_WRAP_SPAN_M;
      params[i * 4 + 1] = stratum + altJitter;
      params[i * 4 + 2] = rz * CLOUD_WRAP_SPAN_M;
      params[i * 4 + 3] = scale;

      const cell = i % 4;
      const uOff = (cell % 2) * 0.5;
      const vOff = Math.floor(cell / 2) * 0.5;
      uvRects[i * 4] = uOff;
      uvRects[i * 4 + 1] = vOff;
      uvRects[i * 4 + 2] = 0.5;
      uvRects[i * 4 + 3] = 0.5;
    }

    cardGeo.setAttribute('aCloudUvRect', new THREE.InstancedBufferAttribute(uvRects, 4));
    cardGeo.setAttribute('aCloudParams', new THREE.InstancedBufferAttribute(params, 4));

    this.cloudDeckMat = new THREE.ShaderMaterial({
      vertexShader: CLOUD_DECK_VERTEX_SHADER,
      fragmentShader: CLOUD_DECK_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
      uniforms: {
        tCloudAtlas: { value: this.cloudAtlasTex },
        uCameraAnchor: { value: new THREE.Vector3() },
        uCamRight: { value: new THREE.Vector3(1, 0, 0) },
        uCamUp: { value: new THREE.Vector3(0, 1, 0) },
        uCloudDrift: { value: 0.0 },
        uWrapSpan: { value: CLOUD_WRAP_SPAN_M },
        uSunDir: { value: new THREE.Vector3(0.4, 0.7, -0.45).normalize() },
        uSunColor: { value: _daySunColor.clone() },
        uCloudLitColor: { value: new THREE.Color(0xf8f9fb) },
        uCloudShadeColor: { value: new THREE.Color(0x697c93) },
        uHorizonColor: { value: _dayHorizon.clone() },
        uCloudOpacity: { value: 0.52 },
        uOcclusionPass: { value: 0.0 },
      },
    });
    this.cloudDeckMesh = new THREE.InstancedMesh(cardGeo, this.cloudDeckMat, CLOUD_DECK_COUNT);
    const idMat = new THREE.Matrix4();
    for (let i = 0; i < CLOUD_DECK_COUNT; i++) {
      this.cloudDeckMesh.setMatrixAt(i, idMat);
    }
    this.cloudDeckMesh.instanceMatrix.needsUpdate = true;
    this.cloudDeckMesh.frustumCulled = false;
    this.cloudDeckMesh.renderOrder = -5;
    this.cloudDeckMesh.layers.enable(OCCLUSION_SKY_LAYER);
    this.scene.add(this.cloudDeckMesh);

    // Mountain Rain curtain (recycled zero-GC Float32Array around camera)
    this.rainPositions = new Float32Array(this.rainCount * 3);
    for (let i = 0; i < this.rainCount; i++) {
      this.rainPositions[i * 3] = (Math.random() - 0.5) * 60;
      this.rainPositions[i * 3 + 1] = Math.random() * 28;
      this.rainPositions[i * 3 + 2] = (Math.random() - 0.5) * 60;
    }
    const rainGeo = new THREE.BufferGeometry();
    rainGeo.setAttribute('position', new THREE.BufferAttribute(this.rainPositions, 3));
    const rainMat = new THREE.PointsMaterial({
      color: 0xc2d5e8,
      size: 0.16,
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
    });
    this.rainPoints = new THREE.Points(rainGeo, rainMat);
    this.rainPoints.visible = false;
    this.rainPoints.frustumCulled = false;
    this.scene.add(this.rainPoints);

    // Hardware GPU Screen-Space Radial Occlusion Godrays
    if (!isSoftwareGl) {
      this.initGodraysResources();
    }

    this.applyLightingAndTelemetry(0, 0, 0);
  }

  private initGodraysResources(): void {
    const rtOpts: THREE.RenderTargetOptions = {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    };
    this.occlusionRt = new THREE.WebGLRenderTarget(480, 270, rtOpts);
    this.godrayRt = new THREE.WebGLRenderTarget(480, 270, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });

    this.occluderBlackMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      fog: false,
      side: THREE.DoubleSide,
    });

    const quadGeo = new THREE.PlaneGeometry(2, 2);
    this.godrayScatterMat = new THREE.ShaderMaterial({
      vertexShader: GODRAY_SCATTER_VERTEX_SHADER,
      fragmentShader: GODRAY_SCATTER_FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tOcclusion: { value: this.occlusionRt.texture },
        uSunScreenUv: { value: new THREE.Vector2(0.5, 0.5) },
        uDensity: { value: 0.94 },
        uDecay: { value: 0.935 },
        uWeight: { value: 0.24 },
        uExposure: { value: 0.56 },
      },
    });
    this.godrayBlurCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.godrayBlurScene = new THREE.Scene();
    const blurQuad = new THREE.Mesh(quadGeo, this.godrayScatterMat);
    blurQuad.frustumCulled = false;
    this.godrayBlurScene.add(blurQuad);

    this.godrayCompositeMat = new THREE.ShaderMaterial({
      vertexShader: GODRAY_COMPOSITE_VERTEX_SHADER,
      fragmentShader: GODRAY_COMPOSITE_FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: {
        tGodrays: { value: this.godrayRt.texture },
        uGodrayTint: { value: new THREE.Color(0xffe1b0) },
        uStrength: { value: 0.62 },
      },
    });
    this.godrayCompositeQuad = new THREE.Mesh(quadGeo, this.godrayCompositeMat);
    this.godrayCompositeQuad.frustumCulled = false;
    this.godrayCompositeQuad.renderOrder = 9999;
    this.godrayCompositeQuad.visible = false;
    this.scene.add(this.godrayCompositeQuad);
  }

  public setSize(width: number, height: number): void {
    if (!this.occlusionRt || !this.godrayRt) return;
    const gw = Math.max(240, Math.min(960, Math.floor(width * 0.45)));
    const gh = Math.max(135, Math.min(540, Math.floor(height * 0.45)));
    if (this.occlusionRt.width !== gw || this.occlusionRt.height !== gh) {
      this.occlusionRt.setSize(gw, gh);
      this.godrayRt.setSize(gw, gh);
    }
  }

  public setGodraysEnabledForPass(enabled: boolean): void {
    this.godraysAllowedForPass = enabled;
    if (this.godrayCompositeQuad) {
      this.godrayCompositeQuad.visible = enabled && this.godraysVisibleThisFrame;
    }
  }

  /**
   * Syncs 3D cloud billboard basis and, on hardware GPUs, renders half-resolution sun/cloud/terrain
   * occlusion mask & radial scatter pass before main Layer 0 render.
   */
  public prepareGodrays(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    camera.getWorldDirection(_camForward);
    // Always sync 3D cloud billboard camera basis (both hardware and software WebGL)
    _camRight.crossVectors(_camForward, camera.up).normalize();
    _camUp.crossVectors(_camRight, _camForward).normalize();
    (this.cloudDeckMat.uniforms.uCamRight.value as THREE.Vector3).copy(_camRight);
    (this.cloudDeckMat.uniforms.uCamUp.value as THREE.Vector3).copy(_camUp);

    if (
      this.isSoftwareGl ||
      !this.occlusionRt ||
      !this.godrayRt ||
      !this.godrayScatterMat ||
      !this.godrayCompositeMat ||
      !this.godrayCompositeQuad ||
      !this.godrayBlurScene ||
      !this.godrayBlurCamera ||
      !this.occluderBlackMat ||
      !this.godraysAllowedForPass
    ) {
      this.godraysVisibleThisFrame = false;
      if (this.godrayCompositeQuad) this.godrayCompositeQuad.visible = false;
      this.telemetry.godraysActive = false;
      return;
    }

    renderer.getDrawingBufferSize(_sizeVec);
    if (_sizeVec.x > 0 && _sizeVec.y > 0) {
      this.setSize(_sizeVec.x, _sizeVec.y);
    }

    const alignDot = _camForward.dot(_sunDir);
    const lowSunDrama =
      this.currentNightFactor < 0.65
        ? 0.42 + 0.58 * Math.exp(-Math.pow(Math.max(0, _sunDir.y - 0.14) * 2.2, 2))
        : 0.28;
    const facingBoost = THREE.MathUtils.smoothstep(alignDot, 0.05, 0.72);
    const strength = facingBoost * lowSunDrama * this.curGodrayScale;

    if (strength <= 0.015) {
      this.godraysVisibleThisFrame = false;
      this.godrayCompositeQuad.visible = false;
      this.telemetry.godraysActive = false;
      return;
    }

    // Project celestial emitter into screen UV (0..1)
    _lightWorldPos.copy(camera.position).addScaledVector(_sunDir, 4400);
    _projectedNdc.copy(_lightWorldPos).project(camera);
    const sunU = _projectedNdc.x * 0.5 + 0.5;
    const sunV = _projectedNdc.y * 0.5 + 0.5;
    if (!Number.isFinite(sunU) || !Number.isFinite(sunV)) {
      this.godraysVisibleThisFrame = false;
      this.godrayCompositeQuad.visible = false;
      this.telemetry.godraysActive = false;
      return;
    }

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevOverride = this.scene.overrideMaterial;
    const prevBg = this.scene.background;
    const prevFog = this.scene.fog;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevRainVis = this.rainPoints.visible;
    const prevMask = camera.layers.mask;

    renderer.getClearColor(_godrayTintColor);
    const prevClearAlpha = renderer.getClearAlpha();

    // Step 1: Half-res Occlusion Buffer
    this.godrayCompositeQuad.visible = false;
    this.rainPoints.visible = false;
    this.scene.background = null;
    this.scene.fog = null;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = false;

    renderer.setRenderTarget(this.occlusionRt);
    renderer.setClearColor(_blackColor, 1);
    renderer.clear(true, true, false);

    // 1A: Sky sun-corona & 3D cloud deck alpha cutouts on OCCLUSION_SKY_LAYER
    this.skyMaterial.uniforms.uOcclusionPass.value = 1.0;
    this.cloudDeckMat.uniforms.uOcclusionPass.value = 1.0;
    this.scene.overrideMaterial = null;
    camera.layers.set(OCCLUSION_SKY_LAYER);
    renderer.render(this.scene, camera);

    // 1B: Depth-tested solid world occluders (terrain, pines, cranes, alpine dam, buildings)
    this.skyDome.visible = false;
    this.cloudDeckMesh.visible = false;
    this.scene.overrideMaterial = this.occluderBlackMat;
    camera.layers.set(0);
    renderer.render(this.scene, camera);

    // Restore scene render state cleanly
    this.skyDome.visible = true;
    this.cloudDeckMesh.visible = true;
    this.skyMaterial.uniforms.uOcclusionPass.value = 0.0;
    this.cloudDeckMat.uniforms.uOcclusionPass.value = 0.0;
    this.scene.overrideMaterial = prevOverride;

    // Step 2: Radial Scatter Blur Pass -> godrayRt
    (this.godrayScatterMat.uniforms.uSunScreenUv.value as THREE.Vector2).set(sunU, sunV);
    renderer.setRenderTarget(this.godrayRt);
    renderer.clear(true, false, false);
    renderer.render(this.godrayBlurScene, this.godrayBlurCamera);

    // Restore renderer & activate fullscreen additive overlay on Layer 0
    renderer.setClearColor(_godrayTintColor, prevClearAlpha);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    this.scene.background = prevBg;
    this.scene.fog = prevFog;
    this.rainPoints.visible = prevRainVis;
    camera.layers.mask = prevMask;

    (this.godrayCompositeMat.uniforms.uGodrayTint.value as THREE.Color).copy(_sunColor);
    this.godrayCompositeMat.uniforms.uStrength.value = THREE.MathUtils.clamp(strength * 0.72, 0, 0.85);
    this.godraysVisibleThisFrame = true;
    this.godrayCompositeQuad.visible = true;
    this.telemetry.godraysActive = true;
  }

  public setTimeOfDay(hours: number): void {
    const wrapped = ((hours % 24) + 24) % 24;
    this.timeOfDayHours = wrapped;
    this.applyLightingAndTelemetry(
      this.skyDome.position.x,
      this.skyDome.position.y,
      this.skyDome.position.z,
    );
  }

  /**
   * Immediately snaps atmosphere preset (used at spawn or deterministic API calls).
   */
  public setWeather(weather: OpenWorldWeatherId): void {
    this.weather = weather;
    const p = WEATHER_PRESETS[weather];
    this.curBaseFog = p.baseFog;
    this.curValleyMist = p.valleyMist;
    this.curHeightFalloff = p.heightFalloff;
    this.curOvercast = p.overcast;
    this.curCloudCoverage = p.cloudCoverage;
    this.curCirrusCoverage = p.cirrusCoverage;
    this.curRainAlpha = p.rainAlpha;
    this.curWeatherVisMult = p.weatherVisMult;
    this.curGodrayScale = p.godrayScale;
    this.curInscatterStrength = p.inscatterStrength;
    this.applyLightingAndTelemetry(
      this.skyDome.position.x,
      this.skyDome.position.y,
      this.skyDome.position.z,
    );
  }

  /**
   * Begins an exponential smooth crossfade toward `weather` over `durationSec` seconds.
   */
  public transitionToWeather(weather: OpenWorldWeatherId, durationSec = 4.5): void {
    this.weather = weather;
    this.crossfadeRate = 3.0 / Math.max(0.25, durationSec);
    this.applyLightingAndTelemetry(
      this.skyDome.position.x,
      this.skyDome.position.y,
      this.skyDome.position.z,
    );
  }

  public setAutoWeatherCycle(enabled: boolean): void {
    this.autoWeatherCycle = enabled;
    if (enabled) {
      this.autoCycleTimerSec = 210;
    }
    this.telemetry.autoWeatherCycle = enabled;
  }

  public isAutoWeatherCycleEnabled(): boolean {
    return this.autoWeatherCycle;
  }

  public setTimeScale(scale: number): void {
    this.timeScale = Math.max(0, Math.min(360, scale));
    this.paused = this.timeScale === 0;
    this.telemetry.timeScale = this.timeScale;
  }

  public getTelemetry(): Readonly<AtmosphereTelemetry> {
    return this.telemetry;
  }

  public getNightFactor(): number {
    return this.currentNightFactor;
  }

  /**
   * Advances the 90-minute day/night cycle, smooth weather crossfade, drifting clouds, and rain.
   * Zero heap allocations per frame.
   */
  public update(dt: number, anchorX: number, anchorY: number, anchorZ: number): void {
    const safeDt = Math.min(0.1, Math.max(0, dt));
    if (!this.paused && this.timeScale > 0) {
      // 24 game-hours per OPENWORLD_DAY_CYCLE_SECONDS (5400s = 90 min)
      const hoursPerSec = 24 / OPENWORLD_DAY_CYCLE_SECONDS;
      this.timeOfDayHours = (this.timeOfDayHours + safeDt * hoursPerSec * this.timeScale) % 24;
    }

    // Autonomous weather cycling when enabled (smooth 12s crossfades)
    if (this.autoWeatherCycle) {
      this.autoCycleTimerSec -= safeDt * (0.35 + Math.min(8, this.timeScale) * 0.65);
      if (this.autoCycleTimerSec <= 0) {
        this.autoCycleIndex = (this.autoCycleIndex + 1) % WEATHER_CYCLE_ORDER.length;
        const nextWeather = WEATHER_CYCLE_ORDER[this.autoCycleIndex];
        this.transitionToWeather(nextWeather, 12.0);
        this.autoCycleTimerSec = 240;
      }
    }

    // Exponentially damp weather & cloud cover parameters toward active target preset
    const target = WEATHER_PRESETS[this.weather];
    const blendAlpha = 1 - Math.exp(-this.crossfadeRate * safeDt);
    this.curBaseFog += (target.baseFog - this.curBaseFog) * blendAlpha;
    this.curValleyMist += (target.valleyMist - this.curValleyMist) * blendAlpha;
    this.curHeightFalloff += (target.heightFalloff - this.curHeightFalloff) * blendAlpha;
    this.curOvercast += (target.overcast - this.curOvercast) * blendAlpha;
    this.curCloudCoverage += (target.cloudCoverage - this.curCloudCoverage) * blendAlpha;
    this.curCirrusCoverage += (target.cirrusCoverage - this.curCirrusCoverage) * blendAlpha;
    this.curRainAlpha += (target.rainAlpha - this.curRainAlpha) * blendAlpha;
    this.curWeatherVisMult += (target.weatherVisMult - this.curWeatherVisMult) * blendAlpha;
    this.curGodrayScale += (target.godrayScale - this.curGodrayScale) * blendAlpha;
    this.curInscatterStrength += (target.inscatterStrength - this.curInscatterStrength) * blendAlpha;

    const windSpeedFactor = 1.0 + this.curOvercast * 0.9;
    this.cloudDriftSeconds += safeDt * windSpeedFactor;

    this.skyDome.position.set(anchorX, anchorY, anchorZ);
    (this.cloudDeckMat.uniforms.uCameraAnchor.value as THREE.Vector3).set(anchorX, anchorY, anchorZ);
    this.cloudDeckMat.uniforms.uCloudDrift.value = this.cloudDriftSeconds;
    this.skyMaterial.uniforms.uCloudDrift.value = this.cloudDriftSeconds;

    this.applyLightingAndTelemetry(anchorX, anchorY, anchorZ);

    // Update rain curtain when Mountain Rain or transitional rain alpha > 0.02
    const rainActive = this.curRainAlpha > 0.02;
    this.rainPoints.visible = rainActive;
    if (rainActive) {
      (this.rainPoints.material as THREE.PointsMaterial).opacity = this.curRainAlpha;
      this.rainPoints.position.set(anchorX, anchorY - 4, anchorZ);
      const fall = safeDt * 24.0;
      const windX = safeDt * 4.5;
      for (let i = 0; i < this.rainCount; i++) {
        const idx = i * 3;
        let x = this.rainPositions[idx] + windX;
        let y = this.rainPositions[idx + 1] - fall;
        if (y < 0) y += 28;
        if (x > 30) x -= 60;
        this.rainPositions[idx] = x;
        this.rainPositions[idx + 1] = y;
      }
      const posAttr = this.rainPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
      posAttr.needsUpdate = true;
    }
  }

  private applyLightingAndTelemetry(anchorX: number, anchorY: number, anchorZ: number): void {
    const hours = this.timeOfDayHours;
    // 06:00 sunrise (0 rad), 12:00 zenith (PI/2), 18:00 sunset (PI), 00:00 nadir (-PI/2)
    const solarAngle = ((hours - 6.0) / 24.0) * Math.PI * 2.0;
    const sunSin = Math.sin(solarAngle);
    const sunCos = Math.cos(solarAngle);
    const sunElevDeg = Math.asin(Math.max(-1, Math.min(1, sunSin))) * (180 / Math.PI);

    // Smooth day / twilight / night blend factors
    const dayFactor = THREE.MathUtils.clamp((sunSin + 0.06) / 0.34, 0, 1);
    const twilightPeak = Math.max(0, 1.0 - Math.abs(sunSin - 0.04) / 0.25);
    const nightFactor = 1.0 - THREE.MathUtils.clamp((sunSin + 0.14) / 0.28, 0, 1);
    this.currentNightFactor = nightFactor;

    const overcast = this.curOvercast;

    // Sky & horizon gradient
    _skyZenith.copy(_nightZenith).lerp(_dayZenith, dayFactor);
    _skyHorizon.copy(_nightHorizon).lerp(_dayHorizon, dayFactor);
    _skyZenith.lerp(_duskZenith, twilightPeak * 0.58);
    _skyHorizon.lerp(_duskHorizon, twilightPeak * 0.76);

    const fogBlend = THREE.MathUtils.clamp((overcast - 0.06) * 1.4, 0, 1);
    const stormRatio = THREE.MathUtils.clamp((overcast - 0.52) * 3.0, 0, 1);
    _cloudShadeColor.copy(_fogOvercast).lerp(_rainOvercast, stormRatio);
    _skyZenith.lerp(_cloudShadeColor, fogBlend * 0.65 * (0.28 + dayFactor * 0.72));
    _skyHorizon.lerp(_cloudShadeColor, fogBlend * 0.86 * (0.28 + dayFactor * 0.72));

    // Active celestial direction (sun by day, moon opposite arc at night)
    _moonDir.set(-sunCos * 0.75, Math.max(0.18, -sunSin * 0.85), 0.42).normalize();
    if (sunSin >= -0.08) {
      _sunDir.set(sunCos * 0.82, Math.max(0.06, sunSin), -0.45).normalize();
      _sunColor.copy(_duskSunColor).lerp(_daySunColor, THREE.MathUtils.clamp(sunSin * 2.5, 0, 1));
      const weatherDim = 1.0 - overcast * 0.52;
      this.sunLight.intensity = THREE.MathUtils.lerp(0.28, 2.38, dayFactor) * weatherDim;
    } else {
      _sunDir.copy(_moonDir);
      _sunColor.copy(_moonColor);
      this.sunLight.intensity = 0.27 * (1.0 - overcast * 0.45);
    }
    this.sunLight.color.copy(_sunColor);

    // Snap directional shadow target to 4m texel steps to eliminate shadow shimmer
    const snapX = Math.round(anchorX / 4) * 4;
    const snapZ = Math.round(anchorZ / 4) * 4;
    this.sunLight.target.position.set(snapX, anchorY, snapZ);
    this.sunLight.position.set(
      snapX + _sunDir.x * 220,
      anchorY + _sunDir.y * 220,
      snapZ + _sunDir.z * 220,
    );

    // Hemisphere ambient fill
    _hemiSky.copy(_skyHorizon).lerp(_skyZenith, 0.4);
    _hemiGround.setRGB(
      THREE.MathUtils.lerp(0.05, 0.23, dayFactor),
      THREE.MathUtils.lerp(0.06, 0.24, dayFactor),
      THREE.MathUtils.lerp(0.08, 0.19, dayFactor),
    );
    this.hemiLight.color.copy(_hemiSky);
    this.hemiLight.groundColor.copy(_hemiGround);
    this.hemiLight.intensity = THREE.MathUtils.lerp(0.22, 0.94, dayFactor) * (1.0 - overcast * 0.22);

    // Sun-inscatter horizon hue
    _inscatterColor
      .copy(_nightInscatter)
      .lerp(_dayInscatter, dayFactor)
      .lerp(_duskInscatter, twilightPeak * 0.82)
      .lerp(_skyHorizon, overcast * 0.45);

    // Horizon-matched FogExp2 + shared world-height valley mist & inscatter uniforms
    _fogColor.copy(_skyHorizon);
    this.fog.color.copy(_fogColor);
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(_fogColor);
    }

    const nightDensMult = 1.0 + nightFactor * 0.22;
    this.fog.density = this.curBaseFog * nightDensMult;

    this.fogUniforms.uAtmoSunDir.value.copy(_sunDir);
    this.fogUniforms.uAtmoSunColor.value.copy(_sunColor);
    this.fogUniforms.uAtmoFogColor.value.copy(_fogColor);
    this.fogUniforms.uAtmoInscatterColor.value.copy(_inscatterColor);
    this.fogUniforms.uAtmoFogParams.value.set(
      this.curBaseFog * nightDensMult,
      this.curValleyMist * (1.0 + nightFactor * 0.18),
      this.curHeightFalloff,
      4.0,
    );
    this.fogUniforms.uAtmoScatterParams.value.set(
      this.curInscatterStrength * (1.0 - nightFactor * 0.62),
      4.8 + dayFactor * 2.2 - overcast * 1.4,
      0.16 + overcast * 0.18,
    );

    // Push sky dome shader uniforms
    const u = this.skyMaterial.uniforms;
    (u.uZenithColor.value as THREE.Color).copy(_skyZenith);
    (u.uHorizonColor.value as THREE.Color).copy(_skyHorizon);
    (u.uInscatterColor.value as THREE.Color).copy(_inscatterColor);
    (u.uSunDir.value as THREE.Vector3).copy(_sunDir);
    (u.uMoonDir.value as THREE.Vector3).copy(_moonDir);
    (u.uSunColor.value as THREE.Color).copy(_sunColor);
    u.uSunIntensity.value = sunSin >= -0.08 ? 0.35 + dayFactor * 0.78 : 0.35;
    u.uNightFactor.value = nightFactor;
    u.uOvercast.value = overcast;
    u.uCirrusCoverage.value = this.curCirrusCoverage;

    // Push 3D cloud deck shader uniforms
    _cloudLitColor
      .copy(_nightHorizon)
      .lerp(_daySunColor, dayFactor * 0.92)
      .lerp(_duskSunColor, twilightPeak * 0.65)
      .lerp(_fogOvercast, overcast * 0.55);
    _cloudShadeColor
      .copy(_nightZenith)
      .lerp(_skyHorizon, 0.38 + dayFactor * 0.32)
      .lerp(_rainOvercast, stormRatio * 0.68);
    const cu = this.cloudDeckMat.uniforms;
    (cu.uSunDir.value as THREE.Vector3).copy(_sunDir);
    (cu.uSunColor.value as THREE.Color).copy(_sunColor);
    (cu.uCloudLitColor.value as THREE.Color).copy(_cloudLitColor);
    (cu.uCloudShadeColor.value as THREE.Color).copy(_cloudShadeColor);
    (cu.uHorizonColor.value as THREE.Color).copy(_fogColor);
    cu.uCloudOpacity.value = 0.34 + this.curCloudCoverage * 0.62;

    // Gameplay telemetry: AI vision cone scaling & covert night ops indicator
    const lightVisMult = THREE.MathUtils.lerp(0.42, 1.0, dayFactor);
    const aiVisionConeMultiplier = Math.max(
      0.25,
      Math.min(1.0, Math.round(lightVisMult * this.curWeatherVisMult * 100) / 100),
    );

    const hh = Math.floor(hours) % 24;
    const mm = Math.floor((hours - Math.floor(hours)) * 60);
    this.telemetry.timeOfDayHours = hours;
    this.telemetry.timeFormatted = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    this.telemetry.phaseLabel =
      nightFactor > 0.65
        ? 'Night Ops'
        : twilightPeak > 0.35
          ? hours < 12
            ? 'Dawn'
            : 'Dusk'
          : 'Daylight';
    this.telemetry.weather = this.weather;
    this.telemetry.weatherLabel = WEATHER_LABELS[this.weather];
    this.telemetry.sunElevationDeg = Math.round(sunElevDeg);
    this.telemetry.ambientLux = Math.round((0.06 + dayFactor * 0.94 * (1 - overcast * 0.4)) * 100) / 100;
    this.telemetry.aiVisionConeMultiplier = aiVisionConeMultiplier;
    this.telemetry.visibilityMeters = Math.round(1.6 / Math.max(0.00025, this.fog.density));
    this.telemetry.nightOpsActive = nightFactor > 0.55;
    this.telemetry.timeScale = this.timeScale;
    this.telemetry.autoWeatherCycle = this.autoWeatherCycle;
    this.telemetry.cloudCoveragePct = Math.round(this.curCloudCoverage * 100);
  }

  public dispose(): void {
    this.scene.remove(this.sunLight);
    this.scene.remove(this.sunLight.target);
    this.scene.remove(this.hemiLight);
    this.scene.remove(this.skyDome);
    this.scene.remove(this.cloudDeckMesh);
    this.scene.remove(this.rainPoints);

    this.skyDome.geometry.dispose();
    this.skyMaterial.dispose();
    this.cloudDeckMesh.geometry.dispose();
    this.cloudDeckMat.dispose();
    this.cloudAtlasTex.dispose();
    this.rainPoints.geometry.dispose();
    (this.rainPoints.material as THREE.Material).dispose();

    if (this.godrayCompositeQuad) {
      this.scene.remove(this.godrayCompositeQuad);
      this.godrayCompositeQuad.geometry.dispose();
      this.godrayCompositeQuad = null;
    }
    this.godrayCompositeMat?.dispose();
    this.godrayScatterMat?.dispose();
    this.occluderBlackMat?.dispose();
    this.occlusionRt?.dispose();
    this.godrayRt?.dispose();
    this.godrayCompositeMat = null;
    this.godrayScatterMat = null;
    this.occluderBlackMat = null;
    this.occlusionRt = null;
    this.godrayRt = null;
    this.godrayBlurScene = null;
    this.godrayBlurCamera = null;
  }
}

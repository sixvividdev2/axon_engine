import * as THREE from 'three';
import {
  BodycamLensPresetId,
  BodycamSDKConfig,
  BodycamTraumaModifiers,
  LENS_PRESETS,
} from './types';

/** Dedicated Three.js render layer for first-person weapon & arm meshes (depth-cleared pass) */
export const VIEWMODEL_LAYER = 1;

const LuminanceDownsampleShader = {
  uniforms: {
    tHdr: { value: null as THREE.Texture | null },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tHdr;
    varying vec2 vUv;

    void main() {
      vec2 texel = vec2(1.0 / 64.0);
      vec3 c0 = texture2D(tHdr, vUv + vec2(-texel.x, -texel.y)).rgb;
      vec3 c1 = texture2D(tHdr, vUv + vec2( texel.x, -texel.y)).rgb;
      vec3 c2 = texture2D(tHdr, vUv + vec2(-texel.x,  texel.y)).rgb;
      vec3 c3 = texture2D(tHdr, vUv + vec2( texel.x,  texel.y)).rgb;
      vec3 avg = (c0 + c1 + c2 + c3) * 0.25;

      float luma = dot(avg, vec3(0.2126, 0.7152, 0.0722));
      float logLuma = log2(max(luma, 0.002));
      float encoded = clamp((logLuma + 6.0) / 12.0, 0.0, 1.0);
      gl_FragColor = vec4(encoded, encoded, encoded, 1.0);
    }
  `,
};

/**
 * Quarter-resolution HDR bright-pass + wide-kernel glare extraction.
 * Drives the subtle Lens Dirt / Smudge Flare so smudges are completely invisible
 * in normal lighting and softly bloom only when bright doorway sunlight or glare hits the lens.
 */
const GlareExtractShader = {
  uniforms: {
    tHdr: { value: null as THREE.Texture | null },
    uExposure: { value: 1.0 },
    uTexel: { value: new THREE.Vector2(1 / 256, 1 / 144) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tHdr;
    uniform float uExposure;
    uniform vec2 uTexel;
    varying vec2 vUv;

    vec3 extractBright(vec2 uv) {
      vec3 c = texture2D(tHdr, clamp(uv, 0.002, 0.998)).rgb * uExposure;
      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // Soft knee above HDR 1.15 so normal midtones contribute zero glare
      float knee = smoothstep(1.05, 2.85, luma);
      return c * knee;
    }

    void main() {
      vec2 o = uTexel * 2.4;
      vec3 acc = extractBright(vUv) * 0.28;
      acc += extractBright(vUv + vec2(-o.x, -o.y)) * 0.12;
      acc += extractBright(vUv + vec2( o.x, -o.y)) * 0.12;
      acc += extractBright(vUv + vec2(-o.x,  o.y)) * 0.12;
      acc += extractBright(vUv + vec2( o.x,  o.y)) * 0.12;
      acc += extractBright(vUv + vec2( o.x * 2.0, 0.0)) * 0.06;
      acc += extractBright(vUv + vec2(-o.x * 2.0, 0.0)) * 0.06;
      acc += extractBright(vUv + vec2(0.0,  o.y * 2.0)) * 0.06;
      acc += extractBright(vUv + vec2(0.0, -o.y * 2.0)) * 0.06;
      gl_FragColor = vec4(min(acc, vec3(6.0)), 1.0);
    }
  `,
};

const GlareBlurShader = {
  uniforms: {
    tGlare: { value: null as THREE.Texture | null },
    uDirection: { value: new THREE.Vector2(1 / 192, 0) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tGlare;
    uniform vec2 uDirection;
    varying vec2 vUv;

    void main() {
      vec3 c = texture2D(tGlare, vUv).rgb * 0.227027;
      c += texture2D(tGlare, clamp(vUv + uDirection * 1.5, 0.002, 0.998)).rgb * 0.1945946;
      c += texture2D(tGlare, clamp(vUv - uDirection * 1.5, 0.002, 0.998)).rgb * 0.1945946;
      c += texture2D(tGlare, clamp(vUv + uDirection * 3.5, 0.002, 0.998)).rgb * 0.1216216;
      c += texture2D(tGlare, clamp(vUv - uDirection * 3.5, 0.002, 0.998)).rgb * 0.1216216;
      c += texture2D(tGlare, clamp(vUv + uDirection * 6.0, 0.002, 0.998)).rgb * 0.0702703;
      c += texture2D(tGlare, clamp(vUv - uDirection * 6.0, 0.002, 0.998)).rgb * 0.0702703;
      gl_FragColor = vec4(c, 1.0);
    }
  `,
};

const BodycamOpticalShader = {
  uniforms: {
    tHdr: { value: null as THREE.Texture | null },
    tGlare: { value: null as THREE.Texture | null },
    tLensDirt: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uFisheye: { value: 0.14 },
    uChromatic: { value: 0.0028 },
    uGrain: { value: 0.055 },
    uExposure: { value: 1.0 },
    uLensDirtStrength: { value: 0.42 },
    uMotionVel: { value: new THREE.Vector2(0, 0) },
    uVignetteStrength: { value: 0.44 },
    uContrastBoost: { value: 1.04 },
    uCoolShadowTint: { value: 0.06 },
    uInjury: { value: 0.0 },
    uBleeding: { value: 0.0 },
    uDesaturation: { value: 0.0 },
    uBlur: { value: 0.0 },
    uChromaticSpike: { value: 0.0 },
    uBreathVignette: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tHdr;
    uniform sampler2D tGlare;
    uniform sampler2D tLensDirt;
    uniform float uTime;
    uniform float uFisheye;
    uniform float uChromatic;
    uniform float uGrain;
    uniform float uExposure;
    uniform float uLensDirtStrength;
    uniform vec2 uMotionVel;
    uniform float uVignetteStrength;
    uniform float uContrastBoost;
    uniform float uCoolShadowTint;
    uniform float uInjury;
    uniform float uBleeding;
    uniform float uDesaturation;
    uniform float uBlur;
    uniform float uChromaticSpike;
    uniform float uBreathVignette;
    varying vec2 vUv;

    float rand(vec2 co) {
      return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
    }

    vec2 barrelDistort(vec2 uv, float k) {
      vec2 centered = uv * 2.0 - 1.0;
      float r2 = dot(centered, centered);
      vec2 warped = centered * (1.0 + k * r2);
      warped /= (1.0 + k * 0.52);
      return warped * 0.5 + 0.5;
    }

    vec3 acesFilmic(vec3 x) {
      const float a = 2.51;
      const float b = 0.03;
      const float c = 2.43;
      const float d = 0.59;
      const float e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
    }

    vec3 linearToSrgb(vec3 lin) {
      vec3 low = lin * 12.92;
      vec3 high = 1.055 * pow(max(lin, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;
      return mix(low, high, step(vec3(0.0031308), lin));
    }

    void main() {
      vec2 uv = barrelDistort(vUv, uFisheye);

      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        gl_FragColor = vec4(0.012, 0.013, 0.015, 1.0);
        return;
      }

      vec2 dir = uv - 0.5;
      float dist = length(dir);

      // Edge-weighted chromatic aberration + concussion spike sampling HDR scene
      float ca = uChromatic * (0.35 + dist * 2.15) + uChromaticSpike * (0.5 + dist * 1.4);
      float r = texture2D(tHdr, clamp(uv - dir * ca, 0.001, 0.999)).r;
      float g = texture2D(tHdr, uv).g;
      float b = texture2D(tHdr, clamp(uv + dir * ca, 0.001, 0.999)).b;
      vec3 hdrColor = vec3(r, g, b);

      // Frame-velocity micro motion-blur / CMOS shutter ghosting during fast torso whips
      float whipSpeed = length(uMotionVel);
      if (whipSpeed > 0.0008) {
        vec2 mStep = uMotionVel;
        vec3 m1 = texture2D(tHdr, clamp(uv - mStep * 0.45, 0.002, 0.998)).rgb;
        vec3 m2 = texture2D(tHdr, clamp(uv - mStep * 0.95, 0.002, 0.998)).rgb;
        vec3 m3 = texture2D(tHdr, clamp(uv + mStep * 0.45, 0.002, 0.998)).rgb;
        vec3 m4 = texture2D(tHdr, clamp(uv + mStep * 0.95, 0.002, 0.998)).rgb;
        vec3 ghost = (hdrColor * 0.40 + m1 * 0.20 + m3 * 0.20 + m2 * 0.10 + m4 * 0.10);
        float blendAmt = clamp(whipSpeed * 38.0, 0.0, 0.72);
        hdrColor = mix(hdrColor, ghost, blendAmt);
      }

      // Concussion vision blur taps
      if (uBlur > 0.01) {
        vec2 blurOff = vec2(0.0032 * uBlur, 0.0022 * uBlur);
        vec3 b0 = texture2D(tHdr, clamp(uv + vec2( blurOff.x,  blurOff.y), 0.001, 0.999)).rgb;
        vec3 b1 = texture2D(tHdr, clamp(uv + vec2(-blurOff.x,  blurOff.y), 0.001, 0.999)).rgb;
        vec3 b2 = texture2D(tHdr, clamp(uv + vec2( blurOff.x, -blurOff.y), 0.001, 0.999)).rgb;
        vec3 b3 = texture2D(tHdr, clamp(uv + vec2(-blurOff.x, -blurOff.y), 0.001, 0.999)).rgb;
        hdrColor = mix(hdrColor, (b0 + b1 + b2 + b3) * 0.25, clamp(uBlur * 0.65, 0.0, 0.65));
      }

      // Apply real auto-exposure BEFORE ACES Filmic Tone Mapping
      vec3 exposed = hdrColor * uExposure;

      // Subtle Lens Dirt / Smudge Flare: invisible in normal lighting, softly blooming
      // when bright doorway sunlight or flashlight glare strikes the glass
      if (uLensDirtStrength > 0.005) {
        vec3 glare = texture2D(tGlare, uv).rgb;
        // Soft wide bloom veil + smudge mask modulation (sampled in screen UV so smudges stay stuck to lens glass)
        float dirtMask = texture2D(tLensDirt, vUv).r;
        float smudgeFine = texture2D(tLensDirt, vUv).g;
        float veilMask = 0.08 + dirtMask * 0.85 + smudgeFine * 0.55;
        exposed += glare * veilMask * uLensDirtStrength * 0.42;
      }

      vec3 tonemapped = acesFilmic(exposed);
      vec3 col = linearToSrgb(tonemapped);

      // Subtle bodycam lens profile contrast & cool shadow rolloff
      if (abs(uContrastBoost - 1.0) > 0.001) {
        col = clamp((col - 0.5) * uContrastBoost + 0.5, 0.0, 1.0);
      }
      if (uCoolShadowTint > 0.001) {
        float lumPre = dot(col, vec3(0.299, 0.587, 0.114));
        float shadowMask = 1.0 - smoothstep(0.02, 0.42, lumPre);
        col += vec3(-0.012, 0.004, 0.022) * shadowMask * (uCoolShadowTint * 14.0);
      }

      // Lens vignette + subtle diegetic hold-breath focus/oxygen edge darkening
      float vig = smoothstep(0.98, 0.24, dist);
      col *= mix(1.0 - uVignetteStrength, 1.0, vig);
      if (uBreathVignette > 0.002) {
        float breathEdge = smoothstep(0.36, 0.86, dist);
        col *= 1.0 - breathEdge * uBreathVignette * 0.24;
      }

      // Diegetic injury desaturation & arterial edge vignette
      float luma = dot(col, vec3(0.299, 0.587, 0.114));
      float desat = clamp(uDesaturation > 0.0 ? uDesaturation : uInjury * 0.54, 0.0, 0.68);
      col = mix(col, vec3(luma), desat);

      float pulse = 0.5 + 0.5 * sin(uTime * 5.4);
      float bleedFactor = clamp(uInjury * 0.62 + uBleeding * (0.28 + 0.28 * pulse), 0.0, 0.92);
      float edgeMask = smoothstep(0.32, 0.78, dist);
      col = mix(col, col * vec3(1.15, 0.30, 0.26) + vec3(0.22, 0.01, 0.01), edgeMask * bleedFactor * 0.78);

      // Luminance-dependent ISO sensor grain (stronger in crushed shadows, cleaner in highlights)
      float shadowWeight = 1.0 - smoothstep(0.04, 0.58, luma);
      float noise = rand(uv * vec2(1280.0, 720.0) + fract(uTime * 43.0)) - 0.5;
      col += noise * uGrain * (0.28 + shadowWeight * 1.45);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

/**
 * Generates a zero-dependency procedural 512x512 Lens Dirt / Smudge Flare mask:
 *  - R channel: soft oily smudges, dried raindrop halos, and edge grime
 *  - G channel: fine micro-dust specks and hairline wipe streaks
 */
function createProceduralLensDirtTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);

  let seed = 48271;
  const rand = (): number => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  // 1. Broad soft oil smudges concentrated slightly toward periphery (keeps center crystal clear)
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 36; i++) {
    const angle = rand() * Math.PI * 2;
    const dist = 0.16 + Math.pow(rand(), 0.7) * 0.42;
    const cx = (0.5 + Math.cos(angle) * dist) * size;
    const cy = (0.5 + Math.sin(angle) * dist) * size;
    const rad = 28 + rand() * 88;
    const intensity = Math.floor(14 + rand() * 34);
    const g = ctx.createRadialGradient(cx, cy, rad * 0.05, cx, cy, rad);
    g.addColorStop(0, `rgb(${intensity}, ${Math.floor(intensity * 0.4)}, 0)`);
    g.addColorStop(0.55, `rgb(${Math.floor(intensity * 0.55)}, ${Math.floor(intensity * 0.25)}, 0)`);
    g.addColorStop(1, 'rgb(0, 0, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  // 2. Dried water droplet rings (subtle bright rim, dark interior)
  for (let i = 0; i < 18; i++) {
    const cx = (0.1 + rand() * 0.8) * size;
    const cy = (0.1 + rand() * 0.8) * size;
    const rad = 10 + rand() * 26;
    const alpha = 0.06 + rand() * 0.12;
    ctx.strokeStyle = `rgba(210, 140, 0, ${alpha.toFixed(3)})`;
    ctx.lineWidth = 1.5 + rand() * 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 3. Micro dust specks & tiny hexagonal bokeh dust motes (G channel)
  for (let i = 0; i < 140; i++) {
    const cx = rand() * size;
    const cy = rand() * size;
    const rad = 1.2 + rand() * 4.5;
    const v = Math.floor(25 + rand() * 75);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0, `rgb(${Math.floor(v * 0.35)}, ${v}, 0)`);
    g.addColorStop(1, 'rgb(0, 0, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  // 4. Faint diagonal cloth-wipe micro-streaks across the glass
  for (let i = 0; i < 22; i++) {
    const x0 = rand() * size;
    const y0 = rand() * size;
    const len = 45 + rand() * 140;
    const ang = -0.35 + (rand() - 0.5) * 0.35;
    ctx.strokeStyle = `rgba(45, 70, 0, ${(0.03 + rand() * 0.05).toFixed(3)})`;
    ctx.lineWidth = 1.2 + rand() * 2.2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export class BodycamPostProcess {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private isSoftwareGl: boolean;

  private hdrTarget: THREE.WebGLRenderTarget;
  private lumTarget: THREE.WebGLRenderTarget;
  private glareTargetA: THREE.WebGLRenderTarget;
  private glareTargetB: THREE.WebGLRenderTarget;
  private lensDirtTex: THREE.CanvasTexture;
  private lumBuffer = new Uint8Array(16 * 16 * 4);

  private quadScene: THREE.Scene;
  private quadCamera: THREE.OrthographicCamera;
  private quadMesh: THREE.Mesh;
  private lumMaterial: THREE.ShaderMaterial;
  private glareExtractMaterial: THREE.ShaderMaterial;
  private glareBlurMaterial: THREE.ShaderMaterial;
  private opticalMaterial: THREE.ShaderMaterial;

  private currentExposure = 0.95;
  private avgLuminance = 0.22;
  private frameCount = 0;
  private beforeMainRenderCallback: (() => void) | null = null;

  private readonly _sizeVec = new THREE.Vector2();

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    isSoftwareGl: boolean,
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.isSoftwareGl = isSoftwareGl;

    // Keep linear HDR values intact during scene pass; ACES runs in our optical shader
    this.renderer.toneMapping = THREE.NoToneMapping;

    renderer.getDrawingBufferSize(this._sizeVec);
    const w = Math.max(1, this._sizeVec.x);
    const h = Math.max(1, this._sizeVec.y);

    this.hdrTarget = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      samples: isSoftwareGl ? 0 : 2,
    });

    this.lumTarget = new THREE.WebGLRenderTarget(16, 16, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });

    const gw = Math.max(64, Math.floor(w / 4));
    const gh = Math.max(36, Math.floor(h / 4));
    const glareOpts: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    };
    this.glareTargetA = new THREE.WebGLRenderTarget(gw, gh, glareOpts);
    this.glareTargetB = new THREE.WebGLRenderTarget(gw, gh, glareOpts);

    this.lensDirtTex = createProceduralLensDirtTexture();

    this.lumMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(LuminanceDownsampleShader.uniforms),
      vertexShader: LuminanceDownsampleShader.vertexShader,
      fragmentShader: LuminanceDownsampleShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });

    this.glareExtractMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(GlareExtractShader.uniforms),
      vertexShader: GlareExtractShader.vertexShader,
      fragmentShader: GlareExtractShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.glareExtractMaterial.uniforms.uTexel.value.set(1 / gw, 1 / gh);

    this.glareBlurMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(GlareBlurShader.uniforms),
      vertexShader: GlareBlurShader.vertexShader,
      fragmentShader: GlareBlurShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });

    this.opticalMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(BodycamOpticalShader.uniforms),
      vertexShader: BodycamOpticalShader.vertexShader,
      fragmentShader: BodycamOpticalShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.opticalMaterial.uniforms.tLensDirt.value = this.lensDirtTex;

    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadScene = new THREE.Scene();
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    this.quadMesh = new THREE.Mesh(quadGeo, this.opticalMaterial);
    this.quadMesh.frustumCulled = false;
    this.quadScene.add(this.quadMesh);
  }

  public setSize(width: number, height: number): void {
    const pr = this.renderer.getPixelRatio();
    const pw = Math.max(1, Math.floor(width * pr));
    const ph = Math.max(1, Math.floor(height * pr));
    this.hdrTarget.setSize(pw, ph);

    const gw = Math.max(64, Math.floor(pw / 4));
    const gh = Math.max(36, Math.floor(ph / 4));
    this.glareTargetA.setSize(gw, gh);
    this.glareTargetB.setSize(gw, gh);
    this.glareExtractMaterial.uniforms.uTexel.value.set(1 / gw, 1 / gh);
  }

  public getAverageLuminance(): number {
    return this.avgLuminance;
  }

  public getCurrentExposure(): number {
    return this.currentExposure;
  }

  public setBeforeMainRenderCallback(fn: (() => void) | null): void {
    this.beforeMainRenderCallback = fn;
  }

  public update(
    delta: number,
    elapsed: number,
    config: Readonly<BodycamSDKConfig>,
    whipVelX = 0,
    whipVelY = 0,
    health = 100,
    bleeding = false,
    trauma?: Readonly<BodycamTraumaModifiers>,
    breathVignette = 0,
  ): void {
    // Compute target exposure from real sampled scene luminance (middle-grey key 0.22)
    const targetExp = THREE.MathUtils.clamp(0.22 / Math.max(0.024, this.avgLuminance), 0.28, 2.85);

    // Asymmetric adaptation: fast iris contraction when stepping into blinding sunlight,
    // slower dilation when entering dark interiors
    const isBrightening = targetExp < this.currentExposure;
    const rate = config.autoExposureSpeed * (isBrightening ? 2.45 : 0.68);
    const k = 1 - Math.exp(-rate * Math.min(delta, 0.05));
    this.currentExposure += (targetExp - this.currentExposure) * k;

    const preset = LENS_PRESETS[config.lensPreset as BodycamLensPresetId] ?? LENS_PRESETS.axon_body_4;
    const u = this.opticalMaterial.uniforms;
    u.uTime.value = elapsed;
    u.uFisheye.value = config.fisheyeStrength;
    u.uChromatic.value = config.chromaticAberration;
    u.uGrain.value = config.isoGrain;
    u.uExposure.value = this.currentExposure;
    u.uLensDirtStrength.value = config.lensDirtStrength;
    u.uVignetteStrength.value = preset.vignetteStrength;
    u.uContrastBoost.value = preset.contrastBoost;
    u.uCoolShadowTint.value = preset.coolShadowTint;
    u.uBreathVignette.value = THREE.MathUtils.clamp(breathVignette, 0, 1);

    // Frame-velocity micro motion-blur / shutter ghosting vector (tightly clamped)
    const mbScale = config.motionBlurStrength * 0.0042;
    const mx = THREE.MathUtils.clamp(whipVelX * mbScale, -0.022, 0.022);
    const my = THREE.MathUtils.clamp(whipVelY * mbScale, -0.018, 0.018);
    u.uMotionVel.value.set(mx, my);

    if (trauma) {
      u.uInjury.value = THREE.MathUtils.clamp(trauma.arterialVignette, 0, 0.72);
      u.uBleeding.value = trauma.anyHeavyBleed ? 1.0 : trauma.anyLightBleed ? 0.55 : 0.0;
      u.uDesaturation.value = THREE.MathUtils.clamp(trauma.desaturation, 0, 0.68);
      u.uBlur.value = THREE.MathUtils.clamp(trauma.concussionBlur, 0, 0.65);
      u.uChromaticSpike.value = THREE.MathUtils.clamp(trauma.chromaticSpike, 0, 0.012);
    } else {
      u.uInjury.value = THREE.MathUtils.clamp((85 - health) / 85, 0, 1);
      u.uBleeding.value = bleeding ? 1.0 : 0.0;
      u.uDesaturation.value = THREE.MathUtils.clamp(((85 - health) / 85) * 0.54, 0, 0.68);
      u.uBlur.value = 0;
      u.uChromaticSpike.value = 0;
    }
  }

  public render(): void {
    this.frameCount++;
    if (this.beforeMainRenderCallback) {
      this.beforeMainRenderCallback();
    }

    // 1. Two-pass HDR render into hdrTarget:
    //    Pass 1 (Layer 0): World, walls, props, player lower body, shadows.
    //    Pass 2 (VIEWMODEL_LAYER): Depth-cleared weapon & arms pass (zero wall clipping).
    const prevAutoClear = this.renderer.autoClear;
    const prevShadowAutoUpdate = this.renderer.shadowMap.autoUpdate;
    const prevBackground = this.scene.background;
    const prevNear = this.camera.near;
    const prevFar = this.camera.far;

    this.renderer.setRenderTarget(this.hdrTarget);
    this.renderer.autoClear = false;
    this.renderer.clear(true, true, true);

    this.camera.layers.set(0);
    this.renderer.render(this.scene, this.camera);

    this.renderer.clearDepth();
    this.renderer.shadowMap.autoUpdate = false;
    this.scene.background = null;
    this.camera.near = 0.015;
    this.camera.far = 4.0;
    this.camera.updateProjectionMatrix();
    this.camera.layers.set(VIEWMODEL_LAYER);
    this.renderer.render(this.scene, this.camera);

    this.camera.layers.set(0);
    this.camera.near = prevNear;
    this.camera.far = prevFar;
    this.camera.updateProjectionMatrix();
    this.scene.background = prevBackground;
    this.renderer.shadowMap.autoUpdate = prevShadowAutoUpdate;
    this.renderer.autoClear = prevAutoClear;

    // 2. Downsample HDR luminance into 16x16 target
    if (!this.isSoftwareGl || this.frameCount % 2 === 0) {
      this.lumMaterial.uniforms.tHdr.value = this.hdrTarget.texture;
      this.quadMesh.material = this.lumMaterial;
      this.renderer.setRenderTarget(this.lumTarget);
      this.renderer.render(this.quadScene, this.quadCamera);

      this.renderer.readRenderTargetPixels(this.lumTarget, 0, 0, 16, 16, this.lumBuffer);

      let weightedLogSum = 0;
      let weightTotal = 0;
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const idx = (y * 16 + x) * 4;
          const encoded = this.lumBuffer[idx] / 255.0;
          const logLuma = encoded * 12.0 - 6.0;
          const dx = (x + 0.5) / 16 - 0.5;
          const dy = (y + 0.5) / 16 - 0.5;
          const w = Math.max(0.25, 1.2 - Math.hypot(dx, dy) * 1.4);
          weightedLogSum += logLuma * w;
          weightTotal += w;
        }
      }
      const meanLog = weightedLogSum / Math.max(0.001, weightTotal);
      this.avgLuminance = Math.pow(2, meanLog);
    }

    // 3. Quarter-res bright-pass glare + separable blur for Lens Dirt / Smudge Flare
    const dirtActive = (this.opticalMaterial.uniforms.uLensDirtStrength.value as number) > 0.005;
    if (dirtActive) {
      this.glareExtractMaterial.uniforms.tHdr.value = this.hdrTarget.texture;
      this.glareExtractMaterial.uniforms.uExposure.value = this.currentExposure;
      this.quadMesh.material = this.glareExtractMaterial;
      this.renderer.setRenderTarget(this.glareTargetA);
      this.renderer.render(this.quadScene, this.quadCamera);

      if (!this.isSoftwareGl) {
        // Horizontal blur A -> B
        this.glareBlurMaterial.uniforms.tGlare.value = this.glareTargetA.texture;
        this.glareBlurMaterial.uniforms.uDirection.value.set(1 / this.glareTargetA.width, 0);
        this.quadMesh.material = this.glareBlurMaterial;
        this.renderer.setRenderTarget(this.glareTargetB);
        this.renderer.render(this.quadScene, this.quadCamera);

        // Vertical blur B -> A
        this.glareBlurMaterial.uniforms.tGlare.value = this.glareTargetB.texture;
        this.glareBlurMaterial.uniforms.uDirection.value.set(0, 1 / this.glareTargetA.height);
        this.renderer.setRenderTarget(this.glareTargetA);
        this.renderer.render(this.quadScene, this.quadCamera);
      }
      this.opticalMaterial.uniforms.tGlare.value = this.glareTargetA.texture;
    }

    // 4. Final optical & CMOS sensor composite to screen
    this.opticalMaterial.uniforms.tHdr.value = this.hdrTarget.texture;
    this.quadMesh.material = this.opticalMaterial;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  public dispose(): void {
    this.hdrTarget.dispose();
    this.lumTarget.dispose();
    this.glareTargetA.dispose();
    this.glareTargetB.dispose();
    this.lensDirtTex.dispose();
    this.quadMesh.geometry.dispose();
    this.lumMaterial.dispose();
    this.glareExtractMaterial.dispose();
    this.glareBlurMaterial.dispose();
    this.opticalMaterial.dispose();
  }
}

import * as THREE from 'three';
import { TRAUMA_LIMITS, TraumaModifiers } from '../../data/traumaConfig';
import { TunerSettings } from '../types';

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
      // Sample 4 taps per 16x16 cell to smooth spatial luminance
      vec2 texel = vec2(1.0 / 64.0);
      vec3 c0 = texture2D(tHdr, vUv + vec2(-texel.x, -texel.y)).rgb;
      vec3 c1 = texture2D(tHdr, vUv + vec2( texel.x, -texel.y)).rgb;
      vec3 c2 = texture2D(tHdr, vUv + vec2(-texel.x,  texel.y)).rgb;
      vec3 c3 = texture2D(tHdr, vUv + vec2( texel.x,  texel.y)).rgb;
      vec3 avg = (c0 + c1 + c2 + c3) * 0.25;

      float luma = dot(avg, vec3(0.2126, 0.7152, 0.0722));
      float logLuma = log2(max(luma, 0.002));
      // Encode [-6.0 .. +6.0] log2 luminance into [0..1]
      float encoded = clamp((logLuma + 6.0) / 12.0, 0.0, 1.0);
      gl_FragColor = vec4(encoded, encoded, encoded, 1.0);
    }
  `,
};

const BodycamOpticalShader = {
  uniforms: {
    tHdr: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uFisheye: { value: 0.14 },
    uChromatic: { value: 0.0028 },
    uGrain: { value: 0.055 },
    uExposure: { value: 1.0 },
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
    uniform float uTime;
    uniform float uFisheye;
    uniform float uChromatic;
    uniform float uGrain;
    uniform float uExposure;
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

      // Concussion vision blur taps (compact 4-tap radial average when uBlur > 0.01)
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
      vec3 tonemapped = acesFilmic(exposed);
      vec3 col = linearToSrgb(tonemapped);

      // Subtle dark lens vignette + diegetic hold-breath focus/oxygen edge darkening
      float vig = smoothstep(0.98, 0.24, dist);
      col *= mix(0.56, 1.0, vig);
      if (uBreathVignette > 0.002) {
        float breathEdge = smoothstep(0.36, 0.86, dist);
        col *= 1.0 - breathEdge * uBreathVignette * 0.24;
      }

      // Diegetic injury desaturation (explicitly clamped to keep silhouette & environment legible)
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

export class BodycamPostProcess {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private isSoftwareGl: boolean;

  private hdrTarget: THREE.WebGLRenderTarget;
  private lumTarget: THREE.WebGLRenderTarget;
  private lumBuffer = new Uint8Array(16 * 16 * 4);

  private quadScene: THREE.Scene;
  private quadCamera: THREE.OrthographicCamera;
  private quadMesh: THREE.Mesh;
  private lumMaterial: THREE.ShaderMaterial;
  private opticalMaterial: THREE.ShaderMaterial;

  private currentExposure = 0.95;
  private avgLuminance = 0.22;
  private frameCount = 0;
  private beforeMainRenderCallback: (() => void) | null = null;

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

    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    const w = Math.max(1, size.x);
    const h = Math.max(1, size.y);

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

    this.lumMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(LuminanceDownsampleShader.uniforms),
      vertexShader: LuminanceDownsampleShader.vertexShader,
      fragmentShader: LuminanceDownsampleShader.fragmentShader,
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

    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadScene = new THREE.Scene();
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    this.quadMesh = new THREE.Mesh(quadGeo, this.opticalMaterial);
    this.quadMesh.frustumCulled = false;
    this.quadScene.add(this.quadMesh);
  }

  public setSize(width: number, height: number): void {
    const pr = this.renderer.getPixelRatio();
    this.hdrTarget.setSize(Math.max(1, Math.floor(width * pr)), Math.max(1, Math.floor(height * pr)));
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
    settings: TunerSettings,
    health: number,
    bleeding: boolean,
    trauma?: Readonly<TraumaModifiers>,
    breathVignette = 0,
  ): void {
    // Compute target exposure from real sampled scene luminance (key value 0.18 middle-grey)
    const targetExp = THREE.MathUtils.clamp(0.22 / Math.max(0.032, this.avgLuminance), 0.36, 2.35);

    // Asymmetric adaptation: fast iris contraction when stepping into bright light,
    // slower dilation when entering dark interiors
    const isBrightening = targetExp < this.currentExposure;
    const rate = settings.autoExposureSpeed * (isBrightening ? 2.45 : 0.68);
    const k = 1 - Math.exp(-rate * Math.min(delta, 0.05));
    this.currentExposure += (targetExp - this.currentExposure) * k;

    const u = this.opticalMaterial.uniforms;
    u.uTime.value = elapsed;
    u.uFisheye.value = settings.fisheyeStrength;
    u.uChromatic.value = settings.chromaticAberration;
    u.uGrain.value = settings.isoGrain;
    u.uExposure.value = this.currentExposure;
    u.uBreathVignette.value = THREE.MathUtils.clamp(breathVignette, 0, 1);

    if (trauma) {
      u.uInjury.value = THREE.MathUtils.clamp(trauma.arterialVignette, 0, TRAUMA_LIMITS.maxArterialVignette);
      u.uBleeding.value = trauma.anyHeavyBleed ? 1.0 : trauma.anyLightBleed ? 0.55 : 0.0;
      u.uDesaturation.value = THREE.MathUtils.clamp(trauma.desaturation, 0, TRAUMA_LIMITS.maxDesaturation);
      u.uBlur.value = THREE.MathUtils.clamp(trauma.concussionBlur, 0, TRAUMA_LIMITS.maxConcussionBlur);
      u.uChromaticSpike.value = THREE.MathUtils.clamp(trauma.chromaticSpike, 0, TRAUMA_LIMITS.maxChromaticSpike);
    } else {
      u.uInjury.value = THREE.MathUtils.clamp((85 - health) / 85, 0, 1);
      u.uBleeding.value = bleeding ? 1.0 : 0.0;
      u.uDesaturation.value = THREE.MathUtils.clamp(((85 - health) / 85) * 0.54, 0, TRAUMA_LIMITS.maxDesaturation);
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
    //    Pass 1 (Layer 0): World, walls, props, zombies, player lower body, shadows.
    //    Pass 2 (VIEWMODEL_LAYER): Clear depth buffer only, then render weapon & arms
    //      with full self-depth-testing so gun models never clip into nearby walls.
    const prevAutoClear = this.renderer.autoClear;
    const prevShadowAutoUpdate = this.renderer.shadowMap.autoUpdate;
    const prevBackground = this.scene.background;
    const prevNear = this.camera.near;
    const prevFar = this.camera.far;

    this.renderer.setRenderTarget(this.hdrTarget);
    this.renderer.autoClear = false;
    this.renderer.clear(true, true, true);

    // Pass 1: World geometry (Layer 0)
    this.camera.layers.set(0);
    this.renderer.render(this.scene, this.camera);

    // Pass 2: Weapon & First-Person Arms Viewmodel Layer (Layer 1)
    this.renderer.clearDepth();
    this.renderer.shadowMap.autoUpdate = false;
    this.scene.background = null;
    this.camera.near = 0.015;
    this.camera.far = 4.0;
    this.camera.updateProjectionMatrix();
    this.camera.layers.set(VIEWMODEL_LAYER);
    this.renderer.render(this.scene, this.camera);

    // Restore camera, scene, and renderer state cleanly for post-process passes
    this.camera.layers.set(0);
    this.camera.near = prevNear;
    this.camera.far = prevFar;
    this.camera.updateProjectionMatrix();
    this.scene.background = prevBackground;
    this.renderer.shadowMap.autoUpdate = prevShadowAutoUpdate;
    this.renderer.autoClear = prevAutoClear;

    // 2. Downsample HDR luminance into 16x16 target (every frame on GPU, every 2nd on Software GL)
    if (!this.isSoftwareGl || this.frameCount % 2 === 0) {
      this.lumMaterial.uniforms.tHdr.value = this.hdrTarget.texture;
      this.quadMesh.material = this.lumMaterial;
      this.renderer.setRenderTarget(this.lumTarget);
      this.renderer.render(this.quadScene, this.quadCamera);

      this.renderer.readRenderTargetPixels(this.lumTarget, 0, 0, 16, 16, this.lumBuffer);

      // Compute center-weighted average log-luminance
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

    // 3. Final optical & CMOS sensor composite to screen
    this.opticalMaterial.uniforms.tHdr.value = this.hdrTarget.texture;
    this.quadMesh.material = this.opticalMaterial;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  public dispose(): void {
    this.hdrTarget.dispose();
    this.lumTarget.dispose();
    this.quadMesh.geometry.dispose();
    this.lumMaterial.dispose();
    this.opticalMaterial.dispose();
  }
}

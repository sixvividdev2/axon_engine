import * as THREE from 'three';
import { AsyncLuminanceReader } from '../AsyncLuminanceReader';
import { WeaponModelAssembly } from './WeaponModelFactory';

const ScopeLumDownsampleShader = {
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
      vec2 texel = vec2(1.0 / 32.0);
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

export interface ScopePassParams {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  mainCamera: THREE.PerspectiveCamera;
  assembly: WeaponModelAssembly | null;
  isMagnifiedOptic: boolean;
  zoomMult: number;
  adsBlend: number;
  cantBlend?: number;
  reticleIlluminated: boolean;
  flashlightOn: boolean;
  sightMisalignYaw: number;
  sightMisalignPitch: number;
  dt: number;
  elapsed: number;
  mainAvgLuminance: number;
  mainExposure?: number;
  motionBlur?: number;
  motionDirX?: number;
  motionDirY?: number;
  opticParallaxStrength?: number;
  sunDirectionWorld?: Readonly<THREE.Vector3>;
}

/**
 * Zero-GC Dual-Render HDR Picture-in-Picture (PiP) Scope Renderer.
 * - Pre-allocates a reusable 640x640 HalfFloat WebGLRenderTarget and dedicated `scopeCamera`
 *   locked exclusively to Layer 0 (world/targets) so viewmodel hands/scope housing are never drawn inside the lens.
 * - Skips ALL GPU work when hip-firing or using 1x reflex optics (`!isMagnifiedOptic || adsBlend <= 0.08`).
 * - Runs independent center-weighted HDR auto-exposure so aiming from dark interiors into bright outdoors
 *   exposes cleanly inside the magnified optic.
 */
export class ScopeRenderer {
  private readonly scopeRT: THREE.WebGLRenderTarget;
  private readonly lumTarget: THREE.WebGLRenderTarget;
  private readonly asyncLumReader = new AsyncLuminanceReader(8, 8, 1.35, 1.8, 0.2, 8);
  private readonly scopeCamera: THREE.PerspectiveCamera;
  private readonly isSoftwareGl: boolean;

  private readonly quadScene: THREE.Scene;
  private readonly quadCamera: THREE.OrthographicCamera;
  private readonly quadMesh: THREE.Mesh;
  private readonly lumMaterial: THREE.ShaderMaterial;

  private scopeExposure = 0.95;
  private avgScopeLuminance = 0.22;
  private frameCount = 0;

  // Zero-GC scratch buffers
  private readonly _objPos = new THREE.Vector3();
  private readonly _objQuat = new THREE.Quaternion();
  private readonly _sightPos = new THREE.Vector3();
  private readonly _sightQuat = new THREE.Quaternion();
  private readonly _camToSight = new THREE.Vector3();
  private readonly _opticRight = new THREE.Vector3();
  private readonly _opticUp = new THREE.Vector3();
  private readonly _opticFwd = new THREE.Vector3();
  private readonly _camPos = new THREE.Vector3();
  private readonly _camQuat = new THREE.Quaternion();
  private readonly _camFwd = new THREE.Vector3();
  private readonly _sunDirDefault = new THREE.Vector3(16, 28, 12).normalize();
  private readonly _cachedSunDir = new THREE.Vector3(16, 28, 12).normalize();
  private sunDirScanned = false;

  constructor(isSoftwareGl: boolean, resolution = 640) {
    this.isSoftwareGl = isSoftwareGl;
    const rtSize = isSoftwareGl ? Math.min(384, resolution) : resolution;

    this.scopeRT = new THREE.WebGLRenderTarget(rtSize, rtSize, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });

    this.lumTarget = new THREE.WebGLRenderTarget(8, 8, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });

    this.scopeCamera = new THREE.PerspectiveCamera(15, 1.0, 0.06, 180);
    // Strict Layer 0 isolation: scopeCamera never sees Layer 1 (player arms/rifle/scope tube)
    this.scopeCamera.layers.set(0);

    this.lumMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(ScopeLumDownsampleShader.uniforms),
      vertexShader: ScopeLumDownsampleShader.vertexShader,
      fragmentShader: ScopeLumDownsampleShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });

    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadScene = new THREE.Scene();
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    this.quadMesh = new THREE.Mesh(quadGeo, this.lumMaterial);
    this.quadMesh.frustumCulled = false;
    this.quadScene.add(this.quadMesh);
  }

  private resolveSunDir(
    scene: THREE.Scene,
    explicit?: Readonly<THREE.Vector3>,
  ): THREE.Vector3 {
    if (explicit) {
      this._cachedSunDir.copy(explicit as THREE.Vector3).normalize();
      return this._cachedSunDir;
    }
    if (!this.sunDirScanned) {
      this.sunDirScanned = true;
      let found: THREE.DirectionalLight | null = null;
      scene.traverse((obj) => {
        if (!found && obj instanceof THREE.DirectionalLight) {
          found = obj;
        }
      });
      if (found) {
        this._cachedSunDir.copy((found as THREE.DirectionalLight).position).normalize();
      } else {
        this._cachedSunDir.copy(this._sunDirDefault);
      }
    }
    return this._cachedSunDir;
  }

  public getCurrentScopeExposure(): number {
    return this.scopeExposure;
  }

  public renderScopePass(params: ScopePassParams): void {
    const {
      renderer,
      scene,
      mainCamera,
      assembly,
      isMagnifiedOptic,
      zoomMult,
      adsBlend,
      reticleIlluminated,
      flashlightOn,
      sightMisalignYaw,
      sightMisalignPitch,
      dt,
      elapsed,
      mainAvgLuminance,
      sunDirectionWorld,
    } = params;

    if (!assembly) return;

    const sunDir = this.resolveSunDir(scene, sunDirectionWorld);
    const flashlightGlare = flashlightOn ? 0.35 : 0.0;
    const mainExp = Math.max(0.25, params.mainExposure ?? 0.95);
    const motionBlur = THREE.MathUtils.clamp(params.motionBlur ?? 0.0, 0.0, 1.0);
    const mDirX = params.motionDirX ?? 1.0;
    const mDirY = params.motionDirY ?? 0.0;
    const parallaxStrength = THREE.MathUtils.clamp(params.opticParallaxStrength ?? 1.0, 0.0, 2.0);
    const cantBlend = THREE.MathUtils.clamp(params.cantBlend ?? 0.0, 0.0, 1.0);
    const hasPrimary1x = Boolean(
      assembly.reticleMaterial && assembly.reticleMaterial !== assembly.scopeLensMaterial,
    );
    const hasCanted1x = Boolean(assembly.cantReticleMaterial);
    let matricesUpdated = false;
    if (hasPrimary1x || hasCanted1x) {
      assembly.group.updateMatrixWorld(true);
      mainCamera.getWorldPosition(this._camPos);
      mainCamera.getWorldQuaternion(this._camQuat);
      this._camFwd.set(0, 0, -1).applyQuaternion(this._camQuat).normalize();
      matricesUpdated = true;
    }

    // Update 1x open reflex / holographic / T-2 red-dot optics (both primary & canted backup)
    const updateCollimatedMat = (
      mat: THREE.ShaderMaterial | null,
      anchor: THREE.Object3D,
      activeWeight: number,
      apertureRadiusM: number,
    ): void => {
      if (!mat || mat === assembly.scopeLensMaterial) return;
      const u = mat.uniforms;
      if (u.uLightDirWorld) u.uLightDirWorld.value.copy(sunDir);
      if (u.uAmbientLuma) u.uAmbientLuma.value = mainAvgLuminance;
      if (u.uIlluminated) u.uIlluminated.value = reticleIlluminated ? 1.0 : 0.0;
      if (u.uFlashlightGlare) u.uFlashlightGlare.value = flashlightGlare;
      if (u.uMainExposure) u.uMainExposure.value = mainExp;
      if (u.uMotionBlur) u.uMotionBlur.value = motionBlur;
      if (u.uMotionDir) u.uMotionDir.value.set(mDirX, mDirY);
      if (u.uTime) u.uTime.value = elapsed;
      if (u.uAdsWeight) u.uAdsWeight.value = activeWeight;
      if (u.uParallaxStrength) u.uParallaxStrength.value = parallaxStrength;

      if (u.uEyeBoxOffset || u.uAngularMisalign) {
        anchor.getWorldPosition(this._sightPos);
        anchor.getWorldQuaternion(this._sightQuat);
        this._opticRight.set(1, 0, 0).applyQuaternion(this._sightQuat).normalize();
        this._opticUp.set(0, 1, 0).applyQuaternion(this._sightQuat).normalize();
        this._opticFwd.set(0, 0, -1).applyQuaternion(this._sightQuat).normalize();

        this._camToSight.subVectors(this._sightPos, this._camPos);
        const safeR = Math.max(0.008, apertureRadiusM);
        const eyeLatX = THREE.MathUtils.clamp(
          -this._camToSight.dot(this._opticRight) / safeR,
          -1.4,
          1.4,
        );
        const eyeLatY = THREE.MathUtils.clamp(
          -this._camToSight.dot(this._opticUp) / safeR,
          -1.4,
          1.4,
        );
        const angDotRight = this._camFwd.dot(this._opticRight);
        const angDotUp = this._camFwd.dot(this._opticUp);
        const misX = THREE.MathUtils.clamp(
          angDotRight * 4.2 + sightMisalignYaw * 2.8,
          -1.0,
          1.0,
        );
        const misY = THREE.MathUtils.clamp(
          angDotUp * 4.2 + sightMisalignPitch * 2.8,
          -1.0,
          1.0,
        );
        if (u.uEyeBoxOffset) u.uEyeBoxOffset.value.set(eyeLatX, eyeLatY);
        if (u.uAngularMisalign) u.uAngularMisalign.value.set(misX, misY);
      }
    };

    const primaryApertureR = Math.max(0.010, assembly.ocularRadiusM || 0.0135);
    updateCollimatedMat(assembly.reticleMaterial, assembly.sightAnchor, adsBlend, primaryApertureR);
    updateCollimatedMat(assembly.cantReticleMaterial, assembly.cantSightAnchor, cantBlend, 0.0115);

    const scopeMat = assembly.scopeLensMaterial;
    if (!scopeMat) return;

    const su = scopeMat.uniforms;
    const scopeAllowsIllum = scopeMat.userData?.hasIllumination !== false;
    su.uLightDirWorld.value.copy(sunDir);
    su.uFlashlightGlare.value = flashlightGlare;
    su.uIlluminated.value = reticleIlluminated && scopeAllowsIllum ? 1.0 : 0.0;
    su.uAdsWeight.value = adsBlend;
    su.uZoomMult.value = Math.max(1.0, zoomMult);
    su.uMainExposure.value = mainExp;
    su.uMotionBlur.value = motionBlur;
    su.uMotionDir.value.set(mDirX, mDirY);
    if (su.uParallaxStrength) su.uParallaxStrength.value = parallaxStrength;
    su.uTime.value = elapsed;

    // ZERO wasted GPU cost when hip-firing, canted onto backup 1x optic, or lowered
    if (!isMagnifiedOptic || adsBlend <= 0.08) {
      su.uHasScopeFeed.value = 0.0;
      return;
    }

    this.frameCount++;

    // Ensure world matrices of the weapon assembly are up to date before syncing scopeCamera
    if (!matricesUpdated) {
      assembly.group.updateMatrixWorld(true);
    }
    assembly.objectiveSocket.getWorldPosition(this._objPos);
    assembly.objectiveSocket.getWorldQuaternion(this._objQuat);

    const eyeReliefM = Math.max(0.06, assembly.adsEyeReliefM || 0.12);
    const ocularRadiusM = Math.max(0.008, assembly.ocularRadiusM || 0.0155);
    const lensAngularDiameterDeg =
      2.0 * THREE.MathUtils.radToDeg(Math.atan(ocularRadiusM / eyeReliefM));
    const clampedZoom = Math.max(1.0, zoomMult);
    const targetFov = THREE.MathUtils.clamp(lensAngularDiameterDeg / clampedZoom, 1.2, 42.0);

    this.scopeCamera.position.copy(this._objPos);
    this.scopeCamera.quaternion.copy(this._objQuat);
    this.scopeCamera.fov = targetFov;
    this.scopeCamera.aspect = 1.0;
    this.scopeCamera.near = 0.06;
    this.scopeCamera.far = mainCamera.far;
    this.scopeCamera.updateProjectionMatrix();
    this.scopeCamera.layers.set(0);

    // Render Layer-0 world into scopeRT BEFORE mainCamera renders hdrTarget
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevShadowAutoUpdate = renderer.shadowMap.autoUpdate;

    renderer.setRenderTarget(this.scopeRT);
    renderer.autoClear = true;
    renderer.shadowMap.autoUpdate = false;
    renderer.clear(true, true, true);
    renderer.render(scene, this.scopeCamera);

    // Independent center-weighted HDR exposure for the magnified sight picture (non-blocking PBO)
    if (!this.isSoftwareGl || this.frameCount % 8 === 0) {
      this.lumMaterial.uniforms.tHdr.value = this.scopeRT.texture;
      this.quadMesh.material = this.lumMaterial;
      renderer.setRenderTarget(this.lumTarget);
      renderer.render(this.quadScene, this.quadCamera);

      const measured = this.asyncLumReader.step(renderer, this.lumTarget, this.isSoftwareGl);
      if (measured !== null && Number.isFinite(measured)) {
        this.avgScopeLuminance = measured;
      }
    }

    const targetScopeExp = THREE.MathUtils.clamp(
      0.20 / Math.max(0.025, this.avgScopeLuminance),
      0.24,
      2.35,
    );
    const brightening = targetScopeExp < this.scopeExposure;
    const rate = brightening ? 5.2 : 1.9;
    const alpha = 1 - Math.exp(-rate * Math.min(Math.max(dt, 0.001), 0.05));
    this.scopeExposure += (targetScopeExp - this.scopeExposure) * alpha;

    // Restore renderer state cleanly for BodycamPostProcess main HDR pass
    renderer.shadowMap.autoUpdate = prevShadowAutoUpdate;
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    // Compute lateral eye-box offset & angular misalignment for optical crescent scope shadow
    assembly.sightAnchor.getWorldPosition(this._sightPos);
    assembly.sightAnchor.getWorldQuaternion(this._sightQuat);
    this._opticRight.set(1, 0, 0).applyQuaternion(this._sightQuat).normalize();
    this._opticUp.set(0, 1, 0).applyQuaternion(this._sightQuat).normalize();
    this._opticFwd.set(0, 0, -1).applyQuaternion(this._sightQuat).normalize();
    this._camFwd.set(0, 0, -1).applyQuaternion(mainCamera.quaternion).normalize();

    this._camToSight.subVectors(this._sightPos, mainCamera.position);
    const eyeLatX = THREE.MathUtils.clamp(
      -this._camToSight.dot(this._opticRight) / ocularRadiusM,
      -1.2,
      1.2,
    );
    const eyeLatY = THREE.MathUtils.clamp(
      -this._camToSight.dot(this._opticUp) / ocularRadiusM,
      -1.2,
      1.2,
    );

    const angDotRight = this._camFwd.dot(this._opticRight);
    const angDotUp = this._camFwd.dot(this._opticUp);
    const misX = THREE.MathUtils.clamp(angDotRight * 3.8 + sightMisalignYaw * 3.2, -0.85, 0.85);
    const misY = THREE.MathUtils.clamp(angDotUp * 3.8 + sightMisalignPitch * 3.2, -0.85, 0.85);

    su.tScopeHdr.value = this.scopeRT.texture;
    su.uHasScopeFeed.value = 1.0;
    su.uScopeExposure.value = this.scopeExposure;
    su.uEyeBoxOffset.value.set(eyeLatX, eyeLatY);
    su.uAngularMisalign.value.set(misX, misY);
  }

  public dispose(): void {
    this.asyncLumReader.dispose();
    this.scopeRT.dispose();
    this.lumTarget.dispose();
    this.quadMesh.geometry.dispose();
    this.lumMaterial.dispose();
  }
}

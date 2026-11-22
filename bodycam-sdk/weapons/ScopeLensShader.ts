import * as THREE from 'three';

export type ScopeReticleMode = 'pso_prism' | 'lpvo_mildot' | 'sniper_mildot';
export type CollimatedReticleMode = 'kobra_chevron' | 'eotech_holo' | 't2_dot' | 'rmr_dot';

export interface ScopeLensMaterialOptions {
  reticleMode: ScopeReticleMode;
  reticleColorHex?: number;
  coatingTintHex?: number;
}

export interface CollimatedReticleMaterialOptions {
  mode: CollimatedReticleMode;
  reticleColorHex?: number;
  coatingTintHex?: number;
  brightness?: number;
}

/**
 * Light-reactive linear HDR Picture-in-Picture (PiP) optical glass shader for magnified scopes.
 * Outputs calibrated LINEAR HDR into the scene's HalfFloat render target so `BodycamPostProcess`
 * applies ACES Filmic + sRGB gamma ONCE (eliminating double-gamma washout and milky fog).
 *
 * Real-world optical behaviors modeled:
 *  - Crystal-clear multi-coated glass transmission when still (~94% clear center, zero hazy center bloom)
 *  - Dynamic motion blur + chromatic edge spread during strafing, fast torso whips, and recoil impulse
 *  - Magnification-scaled exit pupil & crescent scope shadow driven by eye-box offset + recoil misalign
 *  - Grazing-angle Fresnel AR coating & micro-dust only when direct sun/flashlight catches the glass
 *  - Etched FFP/SFP glass reticle with toggleable red/amber illumination
 */
export function createScopeLensMaterial(opts: ScopeLensMaterialOptions): THREE.ShaderMaterial {
  const reticleModeInt =
    opts.reticleMode === 'sniper_mildot'
      ? 2
      : opts.reticleMode === 'lpvo_mildot'
        ? 1
        : 0;
  const defaultZoom = reticleModeInt === 2 ? 10.0 : reticleModeInt === 1 ? 3.0 : 4.0;
  return new THREE.ShaderMaterial({
    uniforms: {
      tScopeHdr: { value: null as THREE.Texture | null },
      uHasScopeFeed: { value: 0.0 },
      uAdsWeight: { value: 0.0 },
      uEyeBoxOffset: { value: new THREE.Vector2(0, 0) },
      uAngularMisalign: { value: new THREE.Vector2(0, 0) },
      uScopeExposure: { value: 0.95 },
      uMainExposure: { value: 0.95 },
      uMotionBlur: { value: 0.0 },
      uMotionDir: { value: new THREE.Vector2(1, 0) },
      uZoomMult: { value: defaultZoom },
      uReticleMode: { value: reticleModeInt },
      uIlluminated: { value: 1.0 },
      uReticleColor: { value: new THREE.Color(opts.reticleColorHex ?? 0xff3422) },
      uCoatingTint: { value: new THREE.Color(opts.coatingTintHex ?? 0x1a7254) },
      uLightDirWorld: { value: new THREE.Vector3(0.45, 0.78, 0.35).normalize() },
      uFlashlightGlare: { value: 0.0 },
      uParallaxStrength: { value: 1.0 },
      uTime: { value: 0.0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;

      void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        // Ocular lens faces +Z toward viewer in local weapon space
        vWorldNormal = normalize((modelMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tScopeHdr;
      uniform float uHasScopeFeed;
      uniform float uAdsWeight;
      uniform vec2 uEyeBoxOffset;
      uniform vec2 uAngularMisalign;
      uniform float uScopeExposure;
      uniform float uMainExposure;
      uniform float uMotionBlur;
      uniform vec2 uMotionDir;
      uniform float uZoomMult;
      uniform int uReticleMode;
      uniform float uIlluminated;
      uniform vec3 uReticleColor;
      uniform vec3 uCoatingTint;
      uniform vec3 uLightDirWorld;
      uniform float uFlashlightGlare;
      uniform float uParallaxStrength;
      uniform float uTime;

      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;

      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      // Etched & illuminated reticle SDFs in normalized [-1..1] ocular disc space
      void evalReticle(vec2 p, out float etchedMask, out float illumMask) {
        etchedMask = 0.0;
        illumMask = 0.0;

        if (uReticleMode == 0) {
          // PSO-4 / PSO-1M2: Center chevron + BDC drop chevrons + stadia ticks + stadiametric rangefinder
          float chev0 = (1.0 - smoothstep(0.0055, 0.0155, abs(-p.y - abs(p.x) * 0.90))) * step(abs(p.x), 0.075);
          float chev1 = (1.0 - smoothstep(0.0045, 0.014, abs((-p.y - 0.13) - abs(p.x) * 0.90))) * step(abs(p.x), 0.058);
          float chev2 = (1.0 - smoothstep(0.0045, 0.014, abs((-p.y - 0.25) - abs(p.x) * 0.90))) * step(abs(p.x), 0.048);
          float chev3 = (1.0 - smoothstep(0.0045, 0.014, abs((-p.y - 0.37) - abs(p.x) * 0.90))) * step(abs(p.x), 0.040);

          // Horizontal mil scale + outer heavy posts
          float hThin = (1.0 - smoothstep(0.0038, 0.010, abs(p.y))) * step(0.11, abs(p.x)) * step(abs(p.x), 0.52);
          float hThick = (1.0 - smoothstep(0.011, 0.020, abs(p.y))) * step(0.52, abs(p.x)) * step(abs(p.x), 0.92);
          float milPhase = abs(fract(p.x * 10.0 + 0.5) - 0.5) / 10.0;
          float hTicks = (1.0 - smoothstep(0.0038, 0.0095, milPhase)) * step(0.12, abs(p.x)) * step(abs(p.x), 0.50) * step(0.0, -p.y) * step(-p.y, 0.032);

          // Vertical lower stadia post
          float vThin = (1.0 - smoothstep(0.0038, 0.010, abs(p.x))) * step(p.y, -0.40) * step(-0.56, p.y);
          float vThick = (1.0 - smoothstep(0.011, 0.020, abs(p.x))) * step(p.y, -0.56) * step(-0.92, p.y);

          // Bottom-left 1.7m stadiametric rangefinder parabola
          float rfRangeX = step(-0.66, p.x) * step(p.x, -0.22);
          float rfBase = (1.0 - smoothstep(0.0038, 0.010, abs(p.y + 0.54))) * rfRangeX;
          float curveY = -0.54 + clamp(0.048 / max(0.12, (-p.x - 0.14)), 0.06, 0.30);
          float rfCurve = (1.0 - smoothstep(0.0038, 0.011, abs(p.y - curveY))) * rfRangeX;

          float allChevs = max(chev0, max(chev1, max(chev2, chev3)));
          etchedMask = max(max(allChevs, max(hThin, hThick)), max(max(hTicks, max(vThin, vThick)), max(rfBase, rfCurve)));
          illumMask = max(chev0, max(chev1 * 0.72, (hTicks + chev2 * 0.55) * 0.65));
        } else if (uReticleMode == 1) {
          // LPVO 1-6x Illuminated Tactical Mil-Dot
          float r = length(p);
          float fineH = (1.0 - smoothstep(0.0032, 0.0088, abs(p.y))) * step(abs(p.x), 0.58) * step(0.03, abs(p.x));
          float fineV = (1.0 - smoothstep(0.0032, 0.0088, abs(p.x))) * step(abs(p.y), 0.58) * step(0.03, abs(p.y));

          // Mil-dot beads every 0.12 units
          float gx = abs(fract(p.x * 8.333 + 0.5) - 0.5) / 8.333;
          float gy = abs(fract(p.y * 8.333 + 0.5) - 0.5) / 8.333;
          float dotsH = (1.0 - smoothstep(0.0065, 0.014, length(vec2(gx, p.y)))) * step(0.08, abs(p.x)) * step(abs(p.x), 0.54);
          float dotsV = (1.0 - smoothstep(0.0065, 0.014, length(vec2(p.x, gy)))) * step(0.08, abs(p.y)) * step(abs(p.y), 0.54);

          // Outer heavy German #4 posts
          float outerH = (1.0 - smoothstep(0.013, 0.022, abs(p.y))) * step(0.58, abs(p.x)) * step(abs(p.x), 0.94);
          float outerB = (1.0 - smoothstep(0.013, 0.022, abs(p.x))) * step(p.y, -0.58) * step(-0.94, p.y);

          // Central illuminated 0.5 MOA dot + segmented CQB horseshoe
          float centerDot = 1.0 - smoothstep(0.010, 0.019, r);
          float ring = (1.0 - smoothstep(0.0045, 0.0125, abs(r - 0.145))) * smoothstep(-0.35, 0.05, p.y);
          float ringSideBreaks = smoothstep(0.025, 0.06, abs(p.y));

          etchedMask = max(max(fineH, fineV), max(max(dotsH, dotsV), max(outerH, outerB)));
          illumMask = max(centerDot, ring * ringSideBreaks * 0.85);
          etchedMask = max(etchedMask, illumMask * 0.88);
        } else {
          // ATACR 5-25x FFP Precision Mil-XT Christmas-Tree Ballistic Grid
          float r = length(p);
          float fineH = (1.0 - smoothstep(0.0024, 0.0066, abs(p.y))) * step(abs(p.x), 0.72) * step(0.018, abs(p.x));
          float fineV = (1.0 - smoothstep(0.0024, 0.0066, abs(p.x))) * step(abs(p.y), 0.72) * step(0.018, abs(p.y));

          // 0.10-unit crisp stadia hash marks along X and Y axes
          float hx = abs(fract(p.x * 10.0 + 0.5) - 0.5) / 10.0;
          float hy = abs(fract(p.y * 10.0 + 0.5) - 0.5) / 10.0;
          float ticksH = (1.0 - smoothstep(0.0022, 0.0058, hx)) * step(abs(p.y), 0.018) * step(0.05, abs(p.x)) * step(abs(p.x), 0.68);
          float ticksV = (1.0 - smoothstep(0.0022, 0.0058, hy)) * step(abs(p.x), 0.018) * step(0.05, abs(p.y)) * step(abs(p.y), 0.68);

          // Lower quadrant Christmas-tree holdover windage dots (p.y < -0.08, widening downward)
          float treeWidth = clamp(-p.y * 0.85, 0.0, 0.55);
          float treeMask = step(-0.62, p.y) * step(p.y, -0.08) * step(abs(p.x), treeWidth);
          float treeDots = (1.0 - smoothstep(0.0045, 0.010, length(vec2(hx, hy)))) * treeMask;

          // Heavy outer tapered bracket bars
          float outerH = (1.0 - smoothstep(0.010, 0.018, abs(p.y))) * step(0.72, abs(p.x)) * step(abs(p.x), 0.94);
          float outerB = (1.0 - smoothstep(0.010, 0.018, abs(p.x))) * step(p.y, -0.72) * step(-0.94, p.y);

          // Illuminated central floating aiming cross + fine dot
          float centerDot = 1.0 - smoothstep(0.007, 0.014, r);
          float illumCrossH = (1.0 - smoothstep(0.003, 0.007, abs(p.y))) * step(abs(p.x), 0.14);
          float illumCrossV = (1.0 - smoothstep(0.003, 0.007, abs(p.x))) * step(p.y, 0.05) * step(-0.14, p.y);

          etchedMask = max(max(fineH, fineV), max(max(ticksH, ticksV), max(treeDots, max(outerH, outerB))));
          illumMask = max(centerDot, max(illumCrossH, illumCrossV) * 0.72);
          etchedMask = max(etchedMask, illumMask * 0.90);
        }
      }

      void main() {
        vec2 lensPos = (vUv - 0.5) * 2.0;
        float r = length(lensPos);
        if (r > 0.995) discard;

        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 N = normalize(vWorldNormal);
        vec3 L = normalize(uLightDirWorld);

        float fresnel = pow(1.0 - max(0.0, dot(V, N)), 3.2);
        vec3 R = reflect(-V, N);
        float sunSpec = pow(max(0.0, dot(R, L)), 18.0);
        float grazingSun = pow(max(0.0, dot(R, L)), 6.0);

        // Micro-scratches & dust haze stay completely dormant unless direct sun/flashlight catches the glass
        float angleA = atan(lensPos.y, lensPos.x);
        float scratch = hash21(vec2(floor(angleA * 26.0), floor(r * 18.0))) * 0.55 +
                        hash21(floor(lensPos * 42.0)) * 0.45;
        float glareStrength = sunSpec * 0.65 + grazingSun * 0.08 + uFlashlightGlare * 0.22;
        vec3 arCoating = uCoatingTint * (0.04 + fresnel * 0.36);
        vec3 dustBloom = mix(uCoatingTint, vec3(1.0, 0.96, 0.88), 0.72) * glareStrength * (0.06 + scratch * 0.14);

        float pipWeight = uHasScopeFeed * smoothstep(0.08, 0.52, uAdsWeight);

        if (pipWeight <= 0.002) {
          // Hip-fire / Inspect / Workbench exterior glass: deep dark optical chamber + crisp AR coating reflection
          vec3 darkChamber = mix(vec3(0.004, 0.006, 0.005), uCoatingTint * 0.04, 0.42);
          float etchedMask;
          float illumMask;
          evalReticle(lensPos, etchedMask, illumMask);
          vec3 extCol = darkChamber + arCoating * (0.18 + 0.45 * fresnel) + dustBloom * 0.35;
          extCol += uReticleColor * illumMask * uIlluminated * 0.24;
          extCol *= 1.0 - smoothstep(0.84, 0.99, r) * 0.78;
          gl_FragColor = vec4(max(extCol, vec3(0.0)), 1.0);
          return;
        }

        // Subtle realistic barrel distortion, physical off-axis optical parallax & edge dispersion
        float motionAmt = clamp(uMotionBlur, 0.0, 1.0);
        float zoomNorm = clamp((uZoomMult - 1.0) / 5.0, 0.0, 1.0);
        float parallaxAmt = clamp(uParallaxStrength, 0.0, 2.0);
        vec2 warped = lensPos * (1.0 + 0.036 * r * r);
        vec2 opticParallax = uEyeBoxOffset * (0.045 + 0.035 * zoomNorm) * parallaxAmt;
        vec2 baseUv = (warped + opticParallax) * 0.5 + 0.5;
        float caAmt = (0.0012 + motionAmt * 0.0028) * r * r;
        vec2 caDir = normalize(lensPos + vec2(1e-5)) * caAmt;

        vec3 hdrSample;
        if (motionAmt > 0.015) {
          // Real-world optical motion blur: 5-tap directional smear along whip/recoil/strafe vector
          // Plus subtle peripheral radial blur at higher magnification
          vec2 mDir = length(uMotionDir) > 0.001 ? normalize(uMotionDir) : vec2(1.0, 0.0);
          float blurSpan = motionAmt * (0.0075 + 0.0095 * zoomNorm + 0.006 * r);
          vec2 stepUv = mDir * blurSpan;

          vec3 s0 = vec3(
            texture2D(tScopeHdr, clamp(baseUv - caDir, 0.002, 0.998)).r,
            texture2D(tScopeHdr, clamp(baseUv, 0.002, 0.998)).g,
            texture2D(tScopeHdr, clamp(baseUv + caDir, 0.002, 0.998)).b
          );
          vec3 s1 = texture2D(tScopeHdr, clamp(baseUv - stepUv * 0.55, 0.002, 0.998)).rgb;
          vec3 s2 = texture2D(tScopeHdr, clamp(baseUv + stepUv * 0.55, 0.002, 0.998)).rgb;
          vec3 s3 = texture2D(tScopeHdr, clamp(baseUv - stepUv * 1.15, 0.002, 0.998)).rgb;
          vec3 s4 = texture2D(tScopeHdr, clamp(baseUv + stepUv * 1.15, 0.002, 0.998)).rgb;
          hdrSample = s0 * 0.36 + (s1 + s2) * 0.22 + (s3 + s4) * 0.10;
        } else {
          // Stationary / steady breathing: tack-sharp single center-crisp optical pass
          float hdrR = texture2D(tScopeHdr, clamp(baseUv - caDir, 0.002, 0.998)).r;
          float hdrG = texture2D(tScopeHdr, clamp(baseUv, 0.002, 0.998)).g;
          float hdrB = texture2D(tScopeHdr, clamp(baseUv + caDir, 0.002, 0.998)).b;
          hdrSample = vec3(hdrR, hdrG, hdrB);
        }

        // Convert scope-adapted linear HDR into main render-target linear units (single ACES pass in BodycamPostProcess!)
        float relExposure = clamp(uScopeExposure / max(0.25, uMainExposure), 0.38, 2.55);
        // Subtle optical glass transmission (~92% Soviet PSO coated prism vs ~96% ED LPVO glass)
        vec3 glassTransmission = mix(vec3(0.91, 0.95, 0.92), vec3(0.95, 0.96, 0.96), step(0.5, float(uReticleMode)));
        vec3 scopeCol = hdrSample * relExposure * glassTransmission;

        // Etched & illuminated reticle
        float etchedMask;
        float illumMask;
        evalReticle(lensPos, etchedMask, illumMask);
        scopeCol = mix(scopeCol, vec3(0.004), etchedMask * 0.96);

        // Scale linear HDR reticle emission inversely with main exposure so it stays crisp and readable
        float invExp = 1.0 / max(0.32, uMainExposure);
        float illumBoost = mix(0.0, 2.45 * invExp, uIlluminated);
        scopeCol += uReticleColor * (illumMask * illumBoost);

        // Edge-only AR sheen & grazing glare (0 fog at optical center when still!)
        float edgeMask = smoothstep(0.58, 0.98, r);
        scopeCol += arCoating * (0.045 * edgeMask + fresnel * 0.06) + dustBloom * (0.08 + 0.55 * edgeMask);

        // Physical exit-pupil eye-box & crescent scope shadow (tighter eye-box at higher magnification)
        float zoomTighten = mix(0.86, 1.38, zoomNorm);
        float shadowGain = mix(0.45, 1.05, clamp(parallaxAmt, 0.0, 1.6));
        vec2 shadowShift = (uEyeBoxOffset * 1.15 + uAngularMisalign * 1.45) * zoomTighten * shadowGain;
        float shadowDist = length(lensPos - shadowShift);
        float eyeReliefOpen = mix(0.26, 1.0, smoothstep(0.08, 0.72, uAdsWeight));
        float pupilPass = 1.0 - smoothstep(0.68 * eyeReliefOpen, 0.99 * eyeReliefOpen, shadowDist);
        float bezelRing = 1.0 - smoothstep(0.87, 0.99, r);
        float shadowFactor = clamp(pupilPass * bezelRing, 0.0, 1.0);

        // Deep matte anodized tube interior in shadow crescent (linear HDR dark)
        vec3 tubeInterior = vec3(0.003, 0.0035, 0.004) + arCoating * 0.015 * fresnel;
        vec3 adsCol = mix(tubeInterior, scopeCol, shadowFactor);

        // Smooth blend from exterior coated glass into live PiP view at ADS entry
        vec3 extGlass = mix(vec3(0.004, 0.006, 0.005), uCoatingTint * 0.04, 0.42) + arCoating * 0.16 + dustBloom * 0.30;
        vec3 finalCol = mix(extGlass, adsCol, pipWeight);

        gl_FragColor = vec4(max(finalCol, vec3(0.0)), 1.0);
      }
    `,
    transparent: false,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    side: THREE.FrontSide,
  });
}

/**
 * Physically distinct 1x optical glass & collimated reticle shader (linear HDR compatible):
 *  - Mode 0 (`kobra_chevron`): Open reflex sight with blue-teal AR notch glass, crisp 3-bar chevron,
 *    open-air sun glare & slight smear during fast movement.
 *  - Mode 1 (`eotech_holo`): True laser-diffracted Holographic sight — nearly clear neutral-white glass,
 *    wide parallax-free rectangular window, authentic granular holographic laser speckle shimmer on the
 *    68 MOA circle + 1 MOA dot.
 *  - Mode 2 (`t2_dot`): Sealed tube Micro Red Dot (Aimpoint T-2) — dichroic cyan-emerald notch tint,
 *    crisp 2 MOA Gaussian LED emitter dot, mild spherical parallax near outer 20% rim, LED starburst/smear
 *    under fast weapon motion or intense glare.
 */
export function createParallaxCollimatedReticleMaterial(
  opts: CollimatedReticleMaterialOptions,
): THREE.ShaderMaterial {
  const modeInt =
    opts.mode === 'eotech_holo'
      ? 1
      : opts.mode === 't2_dot'
        ? 2
        : opts.mode === 'rmr_dot'
          ? 3
          : 0;
  return new THREE.ShaderMaterial({
    uniforms: {
      uMode: { value: modeInt },
      uReticleColor: { value: new THREE.Color(opts.reticleColorHex ?? 0xff2b1f) },
      uBrightness: { value: opts.brightness ?? 2.75 },
      uIlluminated: { value: 1.0 },
      uMainExposure: { value: 0.95 },
      uMotionBlur: { value: 0.0 },
      uMotionDir: { value: new THREE.Vector2(1, 0) },
      uTime: { value: 0.0 },
      uLensTint: { value: new THREE.Color(opts.coatingTintHex ?? 0x1e6c7a) },
      uLightDirWorld: { value: new THREE.Vector3(0.45, 0.78, 0.35).normalize() },
      uFlashlightGlare: { value: 0.0 },
      uAmbientLuma: { value: 0.25 },
      uAdsWeight: { value: 0.0 },
      uEyeBoxOffset: { value: new THREE.Vector2(0, 0) },
      uAngularMisalign: { value: new THREE.Vector2(0, 0) },
      uFocalDistM: { value: 50.0 },
      uParallaxStrength: { value: 1.0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vOpticCenter;
      varying vec3 vWorldNormal;
      varying vec3 vOpticRight;
      varying vec3 vOpticUp;
      varying vec3 vOpticFwd;

      void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        vOpticCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vWorldNormal = normalize((modelMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
        vOpticRight = normalize((modelMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
        vOpticUp = normalize((modelMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        vOpticFwd = normalize((modelMatrix * vec4(0.0, 0.0, -1.0, 0.0)).xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform int uMode;
      uniform vec3 uReticleColor;
      uniform float uBrightness;
      uniform float uIlluminated;
      uniform float uMainExposure;
      uniform float uMotionBlur;
      uniform vec2 uMotionDir;
      uniform float uTime;
      uniform vec3 uLensTint;
      uniform vec3 uLightDirWorld;
      uniform float uFlashlightGlare;
      uniform float uAmbientLuma;
      uniform float uAdsWeight;
      uniform vec2 uEyeBoxOffset;
      uniform vec2 uAngularMisalign;
      uniform float uFocalDistM;
      uniform float uParallaxStrength;

      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vOpticCenter;
      varying vec3 vWorldNormal;
      varying vec3 vOpticRight;
      varying vec3 vOpticUp;
      varying vec3 vOpticFwd;

      float hash21(vec2 p) {
        p = fract(p * vec2(234.34, 567.21));
        p += dot(p, p + 34.45);
        return fract(p.x * p.y);
      }

      float evalKobra(vec2 p) {
        float r = length(p);
        float dotC = 1.0 - smoothstep(0.020, 0.040, r);
        float chevY = -p.y - abs(p.x) * 0.92;
        float chev = (1.0 - smoothstep(0.0, 0.025, abs(chevY - 0.03))) *
          step(abs(p.x), 0.16) * step(-0.22, p.y);
        float sideBars = (1.0 - smoothstep(0.011, 0.023, abs(p.y))) *
          step(0.24, abs(p.x)) * (1.0 - step(0.46, abs(p.x)));
        float botBar = (1.0 - smoothstep(0.011, 0.023, abs(p.x))) *
          step(-0.46, p.y) * (1.0 - step(-0.22, p.y));
        return dotC + chev * 0.88 + (sideBars + botBar) * 0.72;
      }

      float evalEotech(vec2 p) {
        float r = length(p);
        float coreDot = 1.0 - smoothstep(0.017, 0.036, r);
        float dotHalo = exp(-r * r * 360.0) * 0.25;
        float ring = (1.0 - smoothstep(0.0, 0.025, abs(r - 0.34))) * 0.78;
        float angle = atan(p.y, p.x);
        float gapMask = smoothstep(0.08, 0.17, abs(sin(angle * 2.0)));
        float tickH = (1.0 - smoothstep(0.011, 0.023, abs(p.y))) *
          step(0.27, abs(p.x)) * (1.0 - step(0.43, abs(p.x)));
        float tickV = (1.0 - smoothstep(0.011, 0.023, abs(p.x))) *
          step(0.27, abs(p.y)) * (1.0 - step(0.43, abs(p.y)));
        return coreDot + dotHalo + ring * gapMask + (tickH + tickV) * 0.72;
      }

      float evalT2Dot(vec2 p) {
        float r = length(p);
        float core = 1.0 - smoothstep(0.020, 0.042, r);
        float ledBloom = exp(-r * r * 145.0) * 0.36;
        return core + ledBloom;
      }

      float evalRmrDot(vec2 p) {
        float r = length(p);
        float core = 1.0 - smoothstep(0.028, 0.056, r);
        float ledBloom = exp(-r * r * 95.0) * 0.42;
        return core + ledBloom;
      }

      void main() {
        vec2 lensPos = (vUv - 0.5) * 2.0;
        float lensR = length(lensPos);
        if (uMode == 1) {
          vec2 box = abs(lensPos) - vec2(0.88, 0.84);
          if (max(box.x, box.y) > 0.08) discard;
        } else if (uMode == 3) {
          vec2 box = abs(lensPos) - vec2(0.84, 0.78);
          if (max(box.x, box.y) > 0.14) discard;
        } else {
          if (lensR > 0.96) discard;
        }

        // True 3D finite-plane collimated ray-plane intersection (50m ballistic zero plane)
        vec3 rayDir = normalize(vWorldPos - cameraPosition);
        float fwdDot = dot(rayDir, vOpticFwd);
        // Tight physical optical emitter viewing cone — vanishes cleanly when viewed off-angle
        float frontMask = smoothstep(0.76, 0.94, fwdDot);

        float parallaxAmt = clamp(uParallaxStrength, 0.0, 2.0);
        float focalDist = max(1.0, uFocalDistM);
        vec3 focalCenter = vOpticCenter + vOpticFwd * focalDist;
        float tHit = dot(focalCenter - cameraPosition, vOpticFwd) / max(0.20, fwdDot);
        vec3 hitPos = cameraPosition + rayDir * tHit;
        vec3 delta = hitPos - focalCenter;
        vec2 projAng = vec2(dot(delta, vOpticRight), dot(delta, vOpticUp)) / focalDist;
        vec2 ang = mix(lensPos * 0.048, projAng, clamp(parallaxAmt, 0.0, 1.0));

        // Mild spherical edge parallax on compact curved LED reflector glass (Mode 2 T-2 / Mode 0 Kobra / Mode 3 RMR)
        // True Holographic (Mode 1 EOTech) remains edge-to-edge parallax-free!
        if (uMode != 1) {
          float rimCurve = pow(max(0.0, lensR - 0.52), 2.0);
          ang += lensPos * rimCurve * (uMode == 2 ? 0.040 : uMode == 3 ? 0.032 : 0.026) * parallaxAmt;
        }

        float motionAmt = clamp(uMotionBlur, 0.0, 1.0);
        vec2 mDir = length(uMotionDir) > 0.001 ? normalize(uMotionDir) : vec2(1.0, 0.0);
        vec2 smearOff = mDir * (motionAmt * 0.14);

        float reticle = 0.0;
        if (uMode == 0) {
          vec2 p = ang * 15.0;
          reticle = evalKobra(p);
          if (motionAmt > 0.02) {
            reticle = reticle * 0.65 + (evalKobra(p - smearOff) + evalKobra(p + smearOff)) * 0.175;
          }
        } else if (uMode == 1) {
          // EOTech Holographic laser speckle interference texture
          vec2 p = ang * 13.5;
          float baseHolo = evalEotech(p);
          if (motionAmt > 0.02) {
            baseHolo = baseHolo * 0.68 + (evalEotech(p - smearOff * 0.8) + evalEotech(p + smearOff * 0.8)) * 0.16;
          }
          float speckle = hash21(floor(p * 110.0 + ang * 40.0 + floor(uTime * 18.0) * 0.07));
          float holoTexture = mix(0.76, 1.24, speckle);
          reticle = baseHolo * holoTexture;
        } else if (uMode == 3) {
          // Trijicon RMR 3.25 MOA Ruggedized Micro Red Dot
          vec2 p = ang * 15.5;
          reticle = evalRmrDot(p);
          if (motionAmt > 0.02) {
            reticle = reticle * 0.60 + (evalRmrDot(p - smearOff * 0.65) + evalRmrDot(p + smearOff * 0.65)) * 0.20;
          }
        } else {
          // Aimpoint T-2 2 MOA Gaussian LED dot with subtle motion streak under rapid movement
          vec2 p = ang * 14.5;
          reticle = evalT2Dot(p);
          if (motionAmt > 0.02) {
            float trail1 = evalT2Dot(p - smearOff * 0.65);
            float trail2 = evalT2Dot(p + smearOff * 0.65);
            float trail3 = evalT2Dot(p - smearOff * 1.35);
            reticle = reticle * 0.58 + (trail1 + trail2) * 0.16 + trail3 * 0.10;
          }
        }

        // Physical eye-box parallax depth & metal aperture clipping (scaled smoothly during ADS/Cant)
        float eyeWeight = smoothstep(0.10, 0.65, uAdsWeight) * clamp(parallaxAmt, 0.0, 1.75);
        float apertureClip = 1.0;
        float housingShadow = 0.0;
        if (uMode == 2) {
          // Sealed 62mm Aimpoint T-2 tube: crescent inner-wall parallax shadow when eye/bore shifts off-axis
          vec2 tubeShift = (uEyeBoxOffset * 0.52 + uAngularMisalign * 0.68) * eyeWeight;
          float frontApertureDist = length(lensPos - tubeShift);
          housingShadow = smoothstep(0.70, 1.04, frontApertureDist) * min(1.0, eyeWeight);
          apertureClip = 1.0 - smoothstep(0.84, 0.99, frontApertureDist);
        } else if (uMode == 1) {
          // EOTech EXPS3 recessed rectangular hood: subtle inner-wall parallax shading & crisp bezel clip
          vec2 hoodShift = (uEyeBoxOffset * 0.32 + uAngularMisalign * 0.40) * eyeWeight;
          vec2 hoodBox = abs(lensPos - hoodShift);
          float hoodEdge = max(hoodBox.x * 0.96, hoodBox.y * 1.02);
          housingShadow = smoothstep(0.76, 1.05, hoodEdge) * min(1.0, eyeWeight) * 0.72;
          apertureClip = 1.0 - smoothstep(0.84, 0.96, hoodEdge);
        } else {
          // Open reflex (Kobra / RMR): tight outer bezel clip on off-axis eye shifts
          vec2 frameShift = (uEyeBoxOffset * 0.20 + uAngularMisalign * 0.28) * eyeWeight;
          float frameDist = uMode == 3
            ? max(abs(lensPos.x - frameShift.x) * 1.02, abs(lensPos.y - frameShift.y) * 1.08)
            : length(lensPos - frameShift);
          housingShadow = smoothstep(0.82, 1.06, frameDist) * min(1.0, eyeWeight) * 0.42;
          apertureClip = 1.0 - smoothstep(0.86, 0.97, frameDist);
        }

        float bezelFade = (uMode == 1 || uMode == 3)
          ? (1.0 - smoothstep(0.80, 0.95, max(abs(lensPos.x), abs(lensPos.y))))
          : (1.0 - smoothstep(0.84, 0.96, lensR));
        reticle *= frontMask * bezelFade * apertureClip;

        // Distinct physical glass coatings, dual-pane reflections & sun/emitter glare
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 N = normalize(vWorldNormal);
        vec3 L = normalize(uLightDirWorld);
        float ndotv = max(0.0, abs(dot(V, N)));
        float fresnel = pow(1.0 - ndotv, 2.8);
        float glareHit = pow(max(0.0, dot(reflect(-V, N), L)), 12.0) + uFlashlightGlare * 0.25;
        float brightWashout = smoothstep(0.32, 0.95, uAmbientLuma);

        vec3 glassCol;
        float glassAlpha;
        if (uMode == 1) {
          // EOTech EXPS3 dual-pane clear borosilicate glass: minimal tint + subtle dual-surface parallax reflection
          vec2 paneShift = (uEyeBoxOffset * 0.18 + uAngularMisalign * 0.26) * eyeWeight;
          float rearSpec = exp(-dot(lensPos - vec2(0.34, 0.36) + paneShift, lensPos - vec2(0.34, 0.36) + paneShift) * 3.4);
          float frontSpec = exp(-dot(lensPos - vec2(0.28, 0.30) - paneShift * 1.25, lensPos - vec2(0.28, 0.30) - paneShift * 1.25) * 4.2);
          float dualPaneRefl = (rearSpec * 0.045 + frontSpec * 0.035) * (0.35 + glareHit * 0.85);
          float edgeSheen = fresnel * 0.16 + pow(clamp(lensR, 0.0, 1.0), 3.0) * 0.07;
          glassCol = vec3(0.18, 0.21, 0.23) * (edgeSheen + dualPaneRefl) + vec3(1.0, 0.96, 0.90) * glareHit * 0.14;
          glassAlpha = clamp(0.036 + edgeSheen * 0.28 + dualPaneRefl * 0.45 + glareHit * 0.13, 0.0, 0.45);
        } else {
          // Dichroic notch filter glass on LED reflex / tube red dot (angle-dependent cyan-violet shift)
          vec3 grazingShift = mix(uLensTint, vec3(0.14, 0.34, 0.56), clamp(fresnel * 0.75, 0.0, 0.75));
          float rimTint = smoothstep(0.26, 0.95, lensR) * 0.22 + fresnel * 0.34;
          // Subtle off-axis internal emitter reflection glint along lower rim under bright sun/flashlight
          float emitterGlint = smoothstep(0.35, 0.92, -lensPos.y) * glareHit * (uMode == 2 ? 0.06 : 0.14);
          glassCol = grazingShift * (0.12 + rimTint) + vec3(1.0, 0.95, 0.86) * glareHit * 0.18 + uReticleColor * emitterGlint;
          glassAlpha = clamp((uMode == 2 ? 0.13 : 0.095) + rimTint * 0.35 + glareHit * 0.16, 0.0, 0.62);
        }

        // Composite darkened matte-anodized inner tube / hood wall parallax shadow
        vec3 housingWallCol = vec3(0.007, 0.009, 0.011);
        glassCol = mix(glassCol, housingWallCol, housingShadow * 0.92);
        glassAlpha = mix(glassAlpha, 0.92, housingShadow * (uMode == 2 ? 0.88 : 0.72));

        // Calibrate reticle radiance to linear HDR main exposure
        float invExp = 1.0 / max(0.35, uMainExposure);
        float emitterGain = mix(0.22, 1.0, uIlluminated) * (1.0 - brightWashout * 0.24) * invExp;
        vec3 finalCol = glassCol * (0.55 * invExp) + uReticleColor * (reticle * uBrightness * emitterGain);
        float finalAlpha = clamp(glassAlpha + reticle * mix(0.55, 0.98, uIlluminated), 0.0, 1.0);
        gl_FragColor = vec4(max(finalCol, vec3(0.0)), finalAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

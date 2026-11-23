import * as THREE from 'three';

export interface WaterShaderUniforms {
  uTime: { value: number };
  uWindDir: { value: THREE.Vector2 };
  uWindStrength: { value: number };
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uSunIntensity: { value: number };
  uSkyColor: { value: THREE.Color };
  uHorizonColor: { value: THREE.Color };
  uShallowColor: { value: THREE.Color };
  uDeepColor: { value: THREE.Color };
  uFoamColor: { value: THREE.Color };
  uNormalMapA: { value: THREE.Texture };
  uNormalMapB: { value: THREE.Texture };
  fogColor: { value: THREE.Color };
  fogDensity: { value: number };
}

export interface RiverWaterHandle {
  material: THREE.ShaderMaterial;
  uniforms: WaterShaderUniforms;
}

/**
 * Single-pass 60fps AAA-style optical river water shader:
 * - 4-octave wind-coupled Gerstner waves damped cleanly at shallow banks (depth -> 0)
 * - Dual scrolling tangent normal maps for sunlit & moonlit surface shimmer
 * - Schlick Fresnel sky/horizon reflection + specular sun/moon glints
 * - Beer-Lambert depth absorption + cellular shoreline & bridge-pier foam
 * - Seamless zero-depth alpha feathering (eliminates shoreline edge gaps)
 */
export function createRiverWaterMaterial(
  normalMapA: THREE.Texture,
  normalMapB: THREE.Texture,
): RiverWaterHandle {
  const uniforms: WaterShaderUniforms = {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(0.84, 0.54).normalize() },
    uWindStrength: { value: 0.35 },
    uSunDir: { value: new THREE.Vector3(0.45, 0.72, 0.52).normalize() },
    uSunColor: { value: new THREE.Color(0xfff1d6) },
    uSunIntensity: { value: 1.0 },
    uSkyColor: { value: new THREE.Color(0x7090ad) },
    uHorizonColor: { value: new THREE.Color(0x9fb2c2) },
    uShallowColor: { value: new THREE.Color(0x3a6a63) },
    uDeepColor: { value: new THREE.Color(0x0b1c26) },
    uFoamColor: { value: new THREE.Color(0xdfe9ed) },
    uNormalMapA: { value: normalMapA },
    uNormalMapB: { value: normalMapB },
    fogColor: { value: new THREE.Color(0x8ea0b2) },
    fogDensity: { value: 0.0055 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
    transparent: true,
    depthWrite: true,
    fog: true,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec2 uWindDir;
      uniform float uWindStrength;

      attribute float aDepth;
      attribute float aPierMask;

      varying vec3 vWorldPos;
      varying vec3 vWaveNormal;
      varying float vDepth;
      varying float vPierMask;
      varying float vFogDepth;

      vec3 gerstnerWave(vec2 pos, vec2 dir, float steepness, float wavelength, float speedScale, inout vec3 tangent, inout vec3 binormal) {
        float k = 6.2831853 / wavelength;
        float c = sqrt(9.81 / k) * speedScale;
        vec2 d = normalize(dir);
        float f = k * (dot(d, pos) - c * uTime);
        float a = steepness / k;

        tangent += vec3(
          -d.x * d.x * (steepness * sin(f)),
          d.x * (steepness * cos(f)),
          -d.x * d.y * (steepness * sin(f))
        );
        binormal += vec3(
          -d.x * d.y * (steepness * sin(f)),
          d.y * (steepness * cos(f)),
          -d.y * d.y * (steepness * sin(f))
        );

        return vec3(
          d.x * (a * cos(f)),
          a * sin(f),
          d.y * (a * cos(f))
        );
      }

      void main() {
        vec4 worldBase = modelMatrix * vec4(position, 1.0);
        float depthAmp = smoothstep(0.0, 0.55, aDepth);
        float windAmp = clamp(0.32 + uWindStrength * 0.95, 0.25, 1.45);

        vec3 tangent = vec3(1.0, 0.0, 0.0);
        vec3 binormal = vec3(0.0, 0.0, 1.0);
        vec3 disp = vec3(0.0);

        vec2 p = worldBase.xz;
        vec2 streamDir = vec2(0.0, 1.0);
        vec2 windMix1 = normalize(mix(streamDir, uWindDir, 0.55));
        vec2 windMix2 = normalize(vec2(-windMix1.y * 0.45 + 0.35, windMix1.x * 0.65 + 0.55));

        disp += gerstnerWave(p, windMix1, 0.055 * windAmp, 4.6, 0.85, tangent, binormal);
        disp += gerstnerWave(p, windMix2, 0.042 * windAmp, 2.7, 1.05, tangent, binormal);
        disp += gerstnerWave(p, vec2(-0.42, 0.91), 0.030 * windAmp, 1.45, 1.18, tangent, binormal);
        disp += gerstnerWave(p, vec2(0.76, 0.65), 0.022 * windAmp, 0.82, 1.25, tangent, binormal);

        vec3 displacedWorld = worldBase.xyz + disp * depthAmp;
        vec3 gNorm = normalize(cross(binormal, tangent));
        vWaveNormal = normalize(mix(vec3(0.0, 1.0, 0.0), gNorm, depthAmp));
        vWorldPos = displacedWorld;
        vDepth = aDepth;
        vPierMask = aPierMask;

        vec4 mvPosition = viewMatrix * vec4(displacedWorld, 1.0);
        vFogDepth = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec2 uWindDir;
      uniform float uWindStrength;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uSunIntensity;
      uniform vec3 uSkyColor;
      uniform vec3 uHorizonColor;
      uniform vec3 uShallowColor;
      uniform vec3 uDeepColor;
      uniform vec3 uFoamColor;
      uniform sampler2D uNormalMapA;
      uniform sampler2D uNormalMapB;
      uniform vec3 fogColor;
      uniform float fogDensity;

      varying vec3 vWorldPos;
      varying vec3 vWaveNormal;
      varying float vDepth;
      varying float vPierMask;
      varying float vFogDepth;

      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash21(i);
        float b = hash21(i + vec2(1.0, 0.0));
        float c = hash21(i + vec2(0.0, 1.0));
        float d = hash21(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      float cellularFoam(vec2 uv) {
        float n1 = valueNoise(uv * 2.2);
        float n2 = valueNoise(uv * 4.9 + vec2(3.7, -2.1));
        float f = n1 * 0.62 + n2 * 0.38;
        return smoothstep(0.46, 0.78, f);
      }

      void main() {
        // Feather cleanly into terrain at depth <= 0 to leave zero shoreline gaps
        if (vDepth <= 0.003) discard;

        vec3 V = normalize(cameraPosition - vWorldPos);

        // Dual scrolling normal maps driven by stream flow + wind
        vec2 flowA = vec2(0.02, 0.14) + uWindDir * (0.04 * uWindStrength);
        vec2 flowB = vec2(-0.045, 0.09) + vec2(-uWindDir.y, uWindDir.x) * (0.03 * uWindStrength);
        vec2 uvA = vWorldPos.xz * 0.19 + flowA * uTime;
        vec2 uvB = vWorldPos.xz * 0.37 + flowB * uTime;

        vec3 nA = texture2D(uNormalMapA, uvA).xyz * 2.0 - 1.0;
        vec3 nB = texture2D(uNormalMapB, uvB).xyz * 2.0 - 1.0;
        vec3 detailN = normalize(vec3((nA.xy + nB.xy) * 0.42, 1.0));

        vec3 N = normalize(vec3(
          vWaveNormal.x + detailN.x * 0.45,
          vWaveNormal.y,
          vWaveNormal.z + detailN.y * 0.45
        ));

        // Beer-Lambert depth absorption
        float absorb = 1.0 - exp(-max(0.0, vDepth) * 1.65);
        vec3 waterBody = mix(uShallowColor, uDeepColor, clamp(absorb, 0.0, 1.0));

        // Ambient daylight / moonlit illumination scaling water body
        float dayLight = clamp(0.18 + uSunIntensity * 0.62 + max(uSunDir.y, 0.0) * 0.3, 0.08, 1.35);
        waterBody *= dayLight;

        // Schlick Fresnel reflection (sky & horizon)
        float NdotV = max(dot(N, V), 0.001);
        float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 4.5);
        vec3 R = reflect(-V, N);
        float skyGrad = clamp(R.y * 0.65 + 0.25, 0.0, 1.0);
        vec3 envRefl = mix(uHorizonColor, uSkyColor, skyGrad);

        // Sun / Moon directional specular glint
        vec3 L = normalize(uSunDir);
        vec3 H = normalize(L + V);
        float NdotH = max(dot(N, H), 0.0);
        float specTight = pow(NdotH, 240.0) * 2.6;
        float specBroad = pow(NdotH, 32.0) * 0.22;
        vec3 specular = uSunColor * (specTight + specBroad) * max(0.12, uSunIntensity) * smoothstep(-0.08, 0.25, L.y);

        // Animated shoreline & bridge-pier cellular contact foam
        float shoreBand = 1.0 - smoothstep(0.02, 0.42, vDepth);
        float ripplePulse = sin(vDepth * 18.0 - uTime * 2.6 + vWorldPos.z * 0.7) * 0.5 + 0.5;
        float shoreNoise = cellularFoam(vWorldPos.xz * 0.85 + vec2(0.0, -uTime * 0.24));
        float shoreFoam = shoreBand * clamp(shoreNoise * 0.85 + ripplePulse * shoreBand * 0.45, 0.0, 1.0);

        float pierNoise = cellularFoam(vWorldPos.xz * 1.15 + vec2(0.12, -uTime * 0.55));
        float pierFoam = clamp(vPierMask, 0.0, 1.0) * smoothstep(0.22, 0.85, pierNoise);

        float totalFoam = clamp(shoreFoam * 0.88 + pierFoam * 0.92, 0.0, 1.0);

        vec3 color = mix(waterBody, envRefl, clamp(fresnel * 0.88, 0.05, 0.94)) + specular;
        vec3 foamLit = uFoamColor * clamp(0.28 + uSunIntensity * 0.72, 0.16, 1.15);
        color = mix(color, foamLit, totalFoam * 0.86);

        // Scene Exp2 Fog integration
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
        color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

        // Feather alpha seamlessly at shore edge (vDepth 0..0.11m)
        float edgeFeather = smoothstep(0.003, 0.11, vDepth);
        float baseAlpha = clamp(0.58 + absorb * 0.34 + fresnel * 0.25 + totalFoam * 0.35, 0.48, 0.97);
        float alpha = edgeFeather * baseAlpha;

        gl_FragColor = vec4(color, alpha);
      }
    `,
  });

  return { material, uniforms };
}

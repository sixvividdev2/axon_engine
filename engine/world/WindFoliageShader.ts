import * as THREE from 'three';

export interface WindShaderUniforms {
  uTime: { value: number };
  uWindDir: { value: THREE.Vector2 };
  uWindStrength: { value: number };
  uGustFreq: { value: number };
  uWetness: { value: number };
}

export function createWindShaderUniforms(): WindShaderUniforms {
  return {
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(0.86, 0.51).normalize() },
    uWindStrength: { value: 0.28 },
    uGustFreq: { value: 0.85 },
    uWetness: { value: 0.0 },
  };
}

export interface WindFoliageMaterialOptions {
  /** Multiplier for horizontal bend displacement (grass ~0.36, fern ~0.28, shrub ~0.24, tree crown ~0.18) */
  swayScale?: number;
  /** Optional fallback height span if geometry has no explicit `aSway` float attribute */
  fallbackYMin?: number;
  fallbackYSpan?: number;
  /** True for woody bark/trunks with wetness sheen only and subtle upper-trunk sway */
  isTrunk?: boolean;
}

/**
 * Injects world-space directional wind + rolling spatial gust waves + high-frequency flutter
 * into any MeshStandardMaterial using `onBeforeCompile` (preserving PBR shadows & fog).
 */
export function applyWindFoliageShader(
  material: THREE.MeshStandardMaterial,
  uniforms: WindShaderUniforms,
  options: WindFoliageMaterialOptions = {},
): THREE.MeshStandardMaterial {
  const swayScale = options.swayScale ?? 0.28;
  const fallbackYMin = options.fallbackYMin ?? 0.0;
  const fallbackYSpan = Math.max(0.05, options.fallbackYSpan ?? 1.0);
  const isTrunk = Boolean(options.isTrunk);

  const prevBeforeCompile = material.onBeforeCompile;
  material.customProgramCacheKey = () =>
    `axon_wind_foliage_v2_${swayScale.toFixed(2)}_${isTrunk ? 1 : 0}_${fallbackYMin.toFixed(1)}_${fallbackYSpan.toFixed(1)}`;

  material.onBeforeCompile = (shader, renderer) => {
    if (prevBeforeCompile) {
      prevBeforeCompile(shader, renderer);
    }

    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWindDir = uniforms.uWindDir;
    shader.uniforms.uWindStrength = uniforms.uWindStrength;
    shader.uniforms.uGustFreq = uniforms.uGustFreq;
    shader.uniforms.uWetness = uniforms.uWetness;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform vec2 uWindDir;
        uniform float uWindStrength;
        uniform float uGustFreq;
        attribute float aSway;
        `,
      )
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        vec3 wPos = (modelMatrix * mvPosition).xyz;
        float vertexSway = clamp(aSway, 0.0, 1.0);
        if (vertexSway < 0.0001) {
          vertexSway = clamp((transformed.y - (${fallbackYMin.toFixed(3)})) / (${fallbackYSpan.toFixed(3)}), 0.0, 1.0);
          vertexSway = vertexSway * vertexSway;
        }
        float gustPhase = dot(wPos.xz, uWindDir) * 0.22 - uTime * (1.1 + uGustFreq * 1.45);
        float gustRoll = 0.45 + 0.55 * (sin(gustPhase) * 0.5 + 0.5) + 0.25 * sin(gustPhase * 2.13 + wPos.x * 0.19);
        float flutterRate = 3.8 + uWindStrength * 4.2;
        float flutter = sin(uTime * flutterRate + wPos.x * 3.17 + wPos.z * 2.63 + transformed.y * 4.5);
        float bendMag = (${swayScale.toFixed(4)}) * vertexSway * uWindStrength * gustRoll;
        vec2 lateral = vec2(-uWindDir.y, uWindDir.x);
        float flutterAmp = (${isTrunk ? '0.006' : '0.032'}) * vertexSway * (0.25 + uWindStrength * 0.9);
        vec3 windOffset = vec3(
          uWindDir.x * bendMag + lateral.x * flutter * flutterAmp,
          -min(bendMag * 0.24, 0.14) * vertexSway,
          uWindDir.y * bendMag + lateral.y * flutter * flutterAmp
        );
        mvPosition.xyz += windOffset;
        mvPosition = viewMatrix * modelMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uWetness;
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, min(roughnessFactor, ${isTrunk ? '0.32' : '0.26'}), clamp(uWetness, 0.0, 1.0) * 0.72);
        `,
      );
  };

  material.needsUpdate = true;
  return material;
}

/**
 * Ensures any BufferGeometry has a vertex `aSway` attribute weighted 0 at root -> 1 at tip.
 */
export function assignHeightSwayAttribute(
  geometry: THREE.BufferGeometry,
  yMin: number,
  yMax: number,
  exponent = 1.65,
): THREE.BufferGeometry {
  const pos = geometry.getAttribute('position');
  if (!pos) return geometry;
  const span = Math.max(0.05, yMax - yMin);
  const sway = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, Math.min(1, (pos.getY(i) - yMin) / span));
    sway[i] = Math.pow(t, exponent);
  }
  geometry.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));
  return geometry;
}

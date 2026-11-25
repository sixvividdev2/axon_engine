import * as THREE from 'three';
import { HORIZON_FOG_LEAD_M } from '../../data/graphicsQuality';

/**
 * Shared AAA Horizon Distance Fog uniforms.
 * Blends distant scene geometry smoothly into the active horizon/fog color
 * starting exactly `HORIZON_FOG_LEAD_M` (15 m) before the user's Render Distance,
 * preserving full atmospheric FogExp2 depth at closer distances with zero harsh clip pop-in.
 */
export interface HorizonFogUniforms {
  /** x: fogStart (renderDist - 15m), y: fogEnd (renderDist) */
  uHorizonFogRange: { value: THREE.Vector2 };
  /** Synchronized horizon color (fallback if scene.fog is not active) */
  uHorizonFogColor: { value: THREE.Color };
}

export function createHorizonFogUniforms(renderDistanceM = 220): HorizonFogUniforms {
  const end = Math.max(40, renderDistanceM);
  const start = Math.max(12, end - HORIZON_FOG_LEAD_M);
  return {
    uHorizonFogRange: { value: new THREE.Vector2(start, end) },
    uHorizonFogColor: { value: new THREE.Color(0x9ab8d4) },
  };
}

export function updateHorizonFogUniforms(
  uniforms: HorizonFogUniforms,
  renderDistanceM: number,
  scene?: THREE.Scene,
): void {
  const end = Math.max(40, renderDistanceM);
  const start = Math.max(12, end - HORIZON_FOG_LEAD_M);
  uniforms.uHorizonFogRange.value.set(start, end);

  if (scene) {
    if (scene.fog instanceof THREE.FogExp2 || scene.fog instanceof THREE.Fog) {
      uniforms.uHorizonFogColor.value.copy(scene.fog.color);
    } else if (scene.background instanceof THREE.Color) {
      uniforms.uHorizonFogColor.value.copy(scene.background);
    }
  }
}

const PATCHED_MATERIALS = new WeakSet<THREE.Material>();

/**
 * Chains a zero-cost AAA horizon-edge fog ramp `[renderDist - 15m .. renderDist]`
 * onto a standard Three.js material while preserving any existing `onBeforeCompile`
 * shader hooks (e.g., wind sway, wetness). Skips custom ShaderMaterials and Open World
 * atmospheric-fog materials (which natively integrate the same 15 m horizon ramp).
 */
export function applyHorizonDistanceFogToMaterial(
  material: THREE.Material,
  uniforms: HorizonFogUniforms,
): void {
  if (!material || PATCHED_MATERIALS.has(material)) return;
  if (material instanceof THREE.ShaderMaterial || material instanceof THREE.RawShaderMaterial) {
    return;
  }
  if ('fog' in material && (material as { fog?: boolean }).fog === false) return;
  // Skip materials already driven by OpenWorldAtmosphericFogShader
  const prevCacheKey =
    typeof material.customProgramCacheKey === 'function'
      ? material.customProgramCacheKey.bind(material)
      : null;
  if (prevCacheKey && prevCacheKey().includes('ow_atmo_fog')) {
    return;
  }

  PATCHED_MATERIALS.add(material);
  const prevBeforeCompile = material.onBeforeCompile;

  material.customProgramCacheKey = () =>
    `${prevCacheKey ? prevCacheKey() : material.type}_hz_fog_v1`;

  material.onBeforeCompile = (shader, renderer) => {
    if (prevBeforeCompile) {
      prevBeforeCompile(shader, renderer);
    }
    shader.uniforms.uHorizonFogRange = uniforms.uHorizonFogRange;
    shader.uniforms.uHorizonFogColor = uniforms.uHorizonFogColor;

    if (shader.fragmentShader.includes('#include <fog_fragment>')) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform vec2 uHorizonFogRange;
          uniform vec3 uHorizonFogColor;
          `,
        )
        .replace(
          '#include <fog_fragment>',
          `#ifdef USE_FOG
            #ifdef FOG_EXP2
              float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
            #else
              float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
            #endif
            float hzStart = uHorizonFogRange.x;
            float hzEnd = max(hzStart + 1.0, uHorizonFogRange.y);
            float hzT = clamp((vFogDepth - hzStart) / (hzEnd - hzStart), 0.0, 1.0);
            float hzSmooth = hzT * hzT * (3.0 - 2.0 * hzT);
            float hzFinalFog = 1.0 - (1.0 - clamp(fogFactor, 0.0, 1.0)) * (1.0 - hzSmooth);
            gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, clamp(hzFinalFog, 0.0, 1.0) );
          #endif`,
        );
    }
  };
  material.needsUpdate = true;
}

/**
 * Installs AAA 15 m horizon-edge distance fog across all compatible PBR/standard materials
 * in a scene subtree (deduplicated per material instance).
 */
export function installHorizonFogOnSubtree(
  root: THREE.Object3D,
  uniforms: HorizonFogUniforms,
): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.material) return;
    if (Array.isArray(mesh.material)) {
      for (let i = 0; i < mesh.material.length; i++) {
        applyHorizonDistanceFogToMaterial(mesh.material[i], uniforms);
      }
    } else {
      applyHorizonDistanceFogToMaterial(mesh.material, uniforms);
    }
  });
}

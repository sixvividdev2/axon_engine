import * as THREE from 'three';

/**
 * Shared atmospheric fog & Mie sun-inscatter uniform block injected into Open World
 * terrain, water, foliage, prop, and architecture PBR materials via `onBeforeCompile`.
 * Updated in place once per frame with zero heap allocations.
 */
export interface AtmoFogSharedUniforms {
  uAtmoSunDir: { value: THREE.Vector3 };
  uAtmoSunColor: { value: THREE.Color };
  uAtmoFogColor: { value: THREE.Color };
  uAtmoInscatterColor: { value: THREE.Color };
  /** x: base distance density, y: valley mist density, z: height falloff (1/m), w: valley floor Y (m) */
  uAtmoFogParams: { value: THREE.Vector4 };
  /** x: Mie inscatter strength, y: Mie scatter exponent, z: aerial perspective desaturation */
  uAtmoScatterParams: { value: THREE.Vector3 };
  /** x: horizon fog start (renderDist - 15m), y: render distance cutoff (m) */
  uAtmoRenderDist: { value: THREE.Vector2 };
}

export function createAtmoFogSharedUniforms(): AtmoFogSharedUniforms {
  return {
    uAtmoSunDir: { value: new THREE.Vector3(0.4, 0.7, -0.45).normalize() },
    uAtmoSunColor: { value: new THREE.Color(0xfff1dc) },
    uAtmoFogColor: { value: new THREE.Color(0x9ab8d4) },
    uAtmoInscatterColor: { value: new THREE.Color(0xffcfa0) },
    uAtmoFogParams: { value: new THREE.Vector4(0.00038, 0.0009, 0.024, 4.0) },
    uAtmoScatterParams: { value: new THREE.Vector3(0.42, 6.0, 0.22) },
    uAtmoRenderDist: { value: new THREE.Vector2(285.0, 300.0) },
  };
}

/**
 * Chains world-space height-layered valley mist + directional Mie sun-inscatter distance fog
 * + smooth 15m horizon dissolve onto any Three.js MeshStandardMaterial / MeshPhysicalMaterial
 * while preserving existing `onBeforeCompile` hooks (e.g. `WindFoliageShader`).
 */
export function applyAtmosphericHeightFog<T extends THREE.Material>(
  material: T,
  uniforms: AtmoFogSharedUniforms,
): T {
  const prevBeforeCompile = material.onBeforeCompile;
  const prevCacheKey =
    typeof material.customProgramCacheKey === 'function'
      ? material.customProgramCacheKey.bind(material)
      : null;

  material.customProgramCacheKey = () =>
    `${prevCacheKey ? prevCacheKey() : material.type}_ow_atmo_fog_v3`;

  material.onBeforeCompile = (shader, renderer) => {
    if (prevBeforeCompile) {
      prevBeforeCompile(shader, renderer);
    }

    shader.uniforms.uAtmoSunDir = uniforms.uAtmoSunDir;
    shader.uniforms.uAtmoFogColor = uniforms.uAtmoFogColor;
    shader.uniforms.uAtmoInscatterColor = uniforms.uAtmoInscatterColor;
    shader.uniforms.uAtmoFogParams = uniforms.uAtmoFogParams;
    shader.uniforms.uAtmoScatterParams = uniforms.uAtmoScatterParams;
    shader.uniforms.uAtmoRenderDist = uniforms.uAtmoRenderDist;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uAtmoSunDir;
        uniform vec4 uAtmoFogParams;
        uniform vec3 uAtmoScatterParams;
        uniform vec2 uAtmoRenderDist;
        varying vec3 vAtmoFog;
        `,
      )
      .replace(
        '#include <fog_vertex>',
        `vec4 atmoObjPos = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          atmoObjPos = instanceMatrix * atmoObjPos;
        #endif
        vec3 atmoWorldPos = ( modelMatrix * atmoObjPos ).xyz;
        vec3 atmoToVert = atmoWorldPos - cameraPosition;
        float atmoDist = length(atmoToVert);
        vec3 atmoViewDir = atmoToVert / max(atmoDist, 0.0001);

        float atmoBaseDens = uAtmoFogParams.x;
        float atmoMistDens = uAtmoFogParams.y;
        float atmoFalloff = max(0.002, uAtmoFogParams.z);
        float atmoFloorY = uAtmoFogParams.w;

        float atmoCamH = max(-6.0, cameraPosition.y - atmoFloorY);
        float atmoVertH = max(-6.0, atmoWorldPos.y - atmoFloorY);
        float atmoDeltaH = atmoVertH - atmoCamH;
        float atmoRayIntegral = abs(atmoDeltaH) > 0.06
          ? (exp(-atmoFalloff * atmoCamH) - exp(-atmoFalloff * atmoVertH)) / (atmoFalloff * atmoDeltaH)
          : exp(-atmoFalloff * atmoCamH);
        atmoRayIntegral = clamp(atmoRayIntegral, 0.0, 1.45);

        float atmoDistTerm = 1.0 - exp(-pow(atmoBaseDens * atmoDist, 1.16));
        float atmoMistTerm = 1.0 - exp(-atmoMistDens * atmoDist * atmoRayIntegral);
        float atmoBaseFog = clamp(1.0 - (1.0 - atmoDistTerm) * (1.0 - atmoMistTerm * 0.94), 0.0, 1.0);
        // AAA Horizon Dissolve: smoothly blend distant objects into horizon fog over [renderDist - 15m .. renderDist]
        float atmoHorizonRamp = smoothstep(uAtmoRenderDist.x, uAtmoRenderDist.y, atmoDist);
        float atmoHorizonBlend = atmoHorizonRamp * atmoHorizonRamp * (3.0 - 2.0 * atmoHorizonRamp);
        float atmoFogFactor = clamp(max(atmoBaseFog, atmoHorizonBlend), 0.0, 1.0);
        float atmoDesat = clamp(max(atmoDistTerm, atmoHorizonRamp * 0.65) * uAtmoScatterParams.z, 0.0, 0.45);
        float atmoSunAlign = max(dot(atmoViewDir, uAtmoSunDir), 0.0);
        float atmoScatter = clamp(pow(atmoSunAlign, uAtmoScatterParams.y) * uAtmoScatterParams.x, 0.0, 1.0);
        vAtmoFog = vec3(atmoFogFactor, atmoDesat, atmoScatter);
        #include <fog_vertex>`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uAtmoFogColor;
        uniform vec3 uAtmoInscatterColor;
        varying vec3 vAtmoFog;
        `,
      )
      .replace(
        '#include <fog_fragment>',
        `#ifdef USE_FOG
          vec3 atmoTargetFog = mix(uAtmoFogColor, uAtmoInscatterColor, vAtmoFog.z);
          float atmoLum = dot(gl_FragColor.rgb, vec3(0.299, 0.587, 0.114));
          gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(atmoLum), vAtmoFog.y);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, atmoTargetFog, vAtmoFog.x);
        #endif`,
      );
  };

  material.needsUpdate = true;
  return material;
}

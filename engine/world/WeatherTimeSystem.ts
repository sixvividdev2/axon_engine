import * as THREE from 'three';
import { PhysicsInteriorZone } from '../../bodycam-sdk/BodycamPhysics';
import { IBodycamAudioSource } from '../../bodycam-sdk/IBodycamAudioSource';
import { GraphicsQualityId } from '../../data/graphicsQuality';
import {
  ActiveWeatherConditionId,
  TimeOfDayStartSetting,
  WeatherPresetId,
} from '../../data/multiplayer';
import { WaterShaderUniforms } from './WaterShader';
import { WindShaderUniforms } from './WindFoliageShader';

export interface WeatherEnvSyncState {
  activeWeather: ActiveWeatherConditionId;
  targetWeather: ActiveWeatherConditionId;
  transitionAlpha: number;
  gameTimeHours: number;
  windAngleRad: number;
  windSpeedMps: number;
  wetness: number;
}

export interface WettableSurfaceEntry {
  material: THREE.MeshStandardMaterial;
  baseRoughness: number;
  baseEnvMapIntensity: number;
}

export interface NightLightEntry {
  light?: THREE.Light;
  baseLightIntensity?: number;
  emissiveMat?: THREE.MeshStandardMaterial;
  baseEmissiveIntensity?: number;
}

export interface WeatherTimeInitOptions {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  hemiLight: THREE.HemisphereLight;
  keyLight: THREE.DirectionalLight;
  baseFogDensity: number;
  baseEnvIntensity: number;
  supportsDynamicWeatherTime: boolean;
  weatherPreset?: WeatherPresetId;
  timeOfDayStart?: TimeOfDayStartSetting;
  graphicsQuality?: GraphicsQualityId;
  isSoftwareGl?: boolean;
  interiorZones?: readonly PhysicsInteriorZone[];
  windUniforms?: WindShaderUniforms | null;
  waterUniforms?: WaterShaderUniforms | null;
  wettableSurfaces?: WettableSurfaceEntry[];
  nightLights?: NightLightEntry[];
  audio?: IBodycamAudioSource | null;
}

interface WeatherVisualSpec {
  windMinMps: number;
  windMaxMps: number;
  gustStrength: number;
  rainDensity: number;
  fogScale: number;
  sunDim: number;
  cloudMute: number;
  skyTopDay: THREE.Color;
  skyHorizonDay: THREE.Color;
  skyTopNight: THREE.Color;
  skyHorizonNight: THREE.Color;
}

const WEATHER_SPECS: Record<ActiveWeatherConditionId, WeatherVisualSpec> = {
  sunny: {
    windMinMps: 1.2,
    windMaxMps: 4.4,
    gustStrength: 0.22,
    rainDensity: 0.0,
    fogScale: 0.72,
    sunDim: 1.08,
    cloudMute: 0.05,
    skyTopDay: new THREE.Color(0x5b8fc4),
    skyHorizonDay: new THREE.Color(0xbad1e3),
    skyTopNight: new THREE.Color(0x09111e),
    skyHorizonNight: new THREE.Color(0x162235),
  },
  clear: {
    windMinMps: 2.0,
    windMaxMps: 5.8,
    gustStrength: 0.34,
    rainDensity: 0.0,
    fogScale: 0.92,
    sunDim: 0.94,
    cloudMute: 0.18,
    skyTopDay: new THREE.Color(0x6988a5),
    skyHorizonDay: new THREE.Color(0xa6b7c7),
    skyTopNight: new THREE.Color(0x0a111b),
    skyHorizonNight: new THREE.Color(0x182330),
  },
  overcast: {
    windMinMps: 4.2,
    windMaxMps: 9.2,
    gustStrength: 0.52,
    rainDensity: 0.0,
    fogScale: 1.28,
    sunDim: 0.48,
    cloudMute: 0.65,
    skyTopDay: new THREE.Color(0x6d7782),
    skyHorizonDay: new THREE.Color(0x8e97a1),
    skyTopNight: new THREE.Color(0x0b0f16),
    skyHorizonNight: new THREE.Color(0x171d26),
  },
  rainy: {
    windMinMps: 7.4,
    windMaxMps: 14.0,
    gustStrength: 0.72,
    rainDensity: 0.68,
    fogScale: 1.56,
    sunDim: 0.32,
    cloudMute: 0.82,
    skyTopDay: new THREE.Color(0x525d68),
    skyHorizonDay: new THREE.Color(0x74808c),
    skyTopNight: new THREE.Color(0x070b11),
    skyHorizonNight: new THREE.Color(0x111721),
  },
  stormy: {
    windMinMps: 12.8,
    windMaxMps: 22.8,
    gustStrength: 1.0,
    rainDensity: 1.0,
    fogScale: 1.92,
    sunDim: 0.2,
    cloudMute: 0.92,
    skyTopDay: new THREE.Color(0x363f4a),
    skyHorizonDay: new THREE.Color(0x54606c),
    skyTopNight: new THREE.Color(0x04070c),
    skyHorizonNight: new THREE.Color(0x0c1119),
  },
};

const WEATHER_ORDER: ActiveWeatherConditionId[] = ['sunny', 'clear', 'overcast', 'rainy', 'stormy'];

/** Minimum hold duration for an explicitly chosen weather preset: 5 real minutes */
const EXPLICIT_WEATHER_HOLD_SEC = 300;
const WEATHER_TRANSITION_SEC = 25;
/** 1 minute real time = 5 minutes game time => 5 game hours per 60 real minutes = 5 / 3600 hours/sec */
const GAME_HOURS_PER_REAL_SEC = 5 / 3600;

const _tmpSunColor = new THREE.Color();
const _tmpSkyColor = new THREE.Color();
const _tmpHorizonColor = new THREE.Color();
const _tmpGroundColor = new THREE.Color();
const _tmpFogColor = new THREE.Color();
const _tmpFromSky = new THREE.Color();
const _tmpToSky = new THREE.Color();
const _tmpFromHoriz = new THREE.Color();
const _tmpToHoriz = new THREE.Color();
const _colGoldenSun = new THREE.Color(0xffa65c);
const _colMoonBlue = new THREE.Color(0x7a96be);
const _colLightningWhite = new THREE.Color(0xdbe8ff);
const _colWarmHorizon = new THREE.Color(0xd98c66);
const _colLightningSky = new THREE.Color(0xbcd3f5);
const _colNightGround = new THREE.Color(0x06080b);
const _tmpQuat = new THREE.Quaternion();
const _tmpMatrix = new THREE.Matrix4();
const _tmpScale = new THREE.Vector3();
const _tmpPos = new THREE.Vector3();
const _rainUp = new THREE.Vector3(0, 1, 0);
const _rainTilt = new THREE.Vector3();

interface RainDrop {
  x: number;
  y: number;
  z: number;
  speed: number;
  length: number;
}

/**
 * Manages continuous 5x Day/Night solar-lunar cycle, dynamic weather state machine
 * (respecting 5-minute minimum lock on explicitly selected weather), wind speed & gust
 * wave synchronized between GPU foliage, water, HUD, PDA, and Web Audio,
 * indoor-occluded instanced rain streaks, surface wetness, and lightning + delayed thunder.
 */
export class WeatherTimeSystem {
  private readonly scene: THREE.Scene;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly baseFogDensity: number;
  private readonly baseEnvIntensity: number;
  private readonly supportsDynamicWeatherTime: boolean;
  private readonly interiorZones: readonly PhysicsInteriorZone[];
  private readonly windUniforms: WindShaderUniforms | null;
  private readonly waterUniforms: WaterShaderUniforms | null;
  private readonly wettableSurfaces: WettableSurfaceEntry[];
  private readonly nightLights: NightLightEntry[];
  private audio: IBodycamAudioSource | null;

  private weatherPreset: WeatherPresetId;
  private activeWeather: ActiveWeatherConditionId;
  private targetWeather: ActiveWeatherConditionId;
  private transitionAlpha = 1;
  private weatherHoldTimerSec = 0;
  private nextHoldDurationSec: number;

  private gameTimeHours: number;
  private elapsedSec = 0;

  private windAngleRad = 0.56;
  private windSpeedMps = 4.2;
  private windGust01 = 0.25;
  private rainIntensity = 0;
  private wetness = 0;

  private lightningTimerSec = 10;
  private lightningFlash = 0;
  private pendingThunderDelaySec = -1;
  private pendingThunderIntensity = 0;

  // Instanced rain particles centered around camera
  private rainMesh: THREE.InstancedMesh | null = null;
  private rainGeo: THREE.CylinderGeometry | null = null;
  private rainMat: THREE.MeshBasicMaterial | null = null;
  private readonly rainDrops: RainDrop[] = [];
  private readonly maxRainCount: number;
  private readonly rainHalfExtent = 16;
  private readonly rainHeight = 14;

  // 2D wind direction cache (avoid allocation)
  public readonly windDirection = new THREE.Vector2(Math.cos(0.56), Math.sin(0.56));
  public readonly sunDirection = new THREE.Vector3(0.4, 0.7, 0.5).normalize();
  private readonly lastKeyLightDir = new THREE.Vector3(0, 0, 0);

  constructor(opts: WeatherTimeInitOptions) {
    this.scene = opts.scene;
    this.renderer = opts.renderer;
    this.hemiLight = opts.hemiLight;
    this.keyLight = opts.keyLight;
    this.baseFogDensity = opts.baseFogDensity;
    this.baseEnvIntensity = opts.baseEnvIntensity;
    this.supportsDynamicWeatherTime = opts.supportsDynamicWeatherTime;
    this.interiorZones = opts.interiorZones ?? [];
    this.windUniforms = opts.windUniforms ?? null;
    this.waterUniforms = opts.waterUniforms ?? null;
    this.wettableSurfaces = opts.wettableSurfaces ?? [];
    this.nightLights = opts.nightLights ?? [];
    this.audio = opts.audio ?? null;

    this.weatherPreset = opts.weatherPreset ?? 'auto';
    if (this.weatherPreset === 'auto') {
      const roll = Math.random();
      const autoPick: ActiveWeatherConditionId =
        roll < 0.24
          ? 'sunny'
          : roll < 0.52
            ? 'clear'
            : roll < 0.78
              ? 'overcast'
              : roll < 0.93
                ? 'rainy'
                : 'stormy';
      this.activeWeather = autoPick;
      this.targetWeather = autoPick;
      this.nextHoldDurationSec = 90 + Math.random() * 110;
    } else {
      this.activeWeather = this.weatherPreset;
      this.targetWeather = this.weatherPreset;
      // Enforce >= 5 real minutes before shifting from chosen preset
      this.nextHoldDurationSec = EXPLICIT_WEATHER_HOLD_SEC + Math.random() * 140;
    }

    if (typeof opts.timeOfDayStart === 'number' && Number.isFinite(opts.timeOfDayStart)) {
      this.gameTimeHours = ((opts.timeOfDayStart % 24) + 24) % 24;
    } else if (opts.timeOfDayStart === 'auto') {
      // Weighted realistic operational window (mostly daylight/dusk/dawn with some night raids)
      const bands = [7.2, 9.5, 13.0, 16.5, 18.8, 22.0, 2.5];
      this.gameTimeHours = bands[Math.floor(Math.random() * bands.length)] + (Math.random() - 0.5) * 1.4;
      this.gameTimeHours = ((this.gameTimeHours % 24) + 24) % 24;
    } else {
      this.gameTimeHours = 13.25;
    }

    // Initialize baseline wetness for rainy/stormy starts
    if (this.activeWeather === 'rainy') this.wetness = 0.72;
    else if (this.activeWeather === 'stormy') this.wetness = 0.95;
    else if (this.activeWeather === 'overcast') this.wetness = 0.16;

    const quality = opts.graphicsQuality ?? 'high';
    if (opts.isSoftwareGl) {
      this.maxRainCount = 0;
    } else if (quality === 'performance') {
      this.maxRainCount = 420;
    } else if (quality === 'balanced') {
      this.maxRainCount = 780;
    } else {
      this.maxRainCount = 1250;
    }

    if (this.maxRainCount > 0 && this.supportsDynamicWeatherTime) {
      this.initRainPool();
    }

    // Perform an immediate step(0) to push exact initial lighting, fog, wetness & audio
    this.update(0, opts.keyLight.position.clone().set(0, 1.7, 0));
  }

  public setAudio(audio: IBodycamAudioSource | null): void {
    this.audio = audio;
  }

  private initRainPool(): void {
    this.rainGeo = new THREE.CylinderGeometry(0.0055, 0.0055, 1.0, 4, 1, true);
    this.rainMat = new THREE.MeshBasicMaterial({
      color: 0xcbd8e6,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.rainMesh = new THREE.InstancedMesh(this.rainGeo, this.rainMat, this.maxRainCount);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.count = 0;
    this.rainMesh.name = 'WeatherRainStreaks';

    for (let i = 0; i < this.maxRainCount; i++) {
      this.rainDrops.push({
        x: (Math.random() * 2 - 1) * this.rainHalfExtent,
        y: Math.random() * this.rainHeight,
        z: (Math.random() * 2 - 1) * this.rainHalfExtent,
        speed: 17 + Math.random() * 8,
        length: 0.45 + Math.random() * 0.45,
      });
    }
    this.scene.add(this.rainMesh);
  }

  private isInsideRoof(x: number, y: number, z: number): boolean {
    for (let i = 0; i < this.interiorZones.length; i++) {
      const iz = this.interiorZones[i];
      if (
        x >= iz.minX &&
        x <= iz.maxX &&
        z >= iz.minZ &&
        z <= iz.maxZ &&
        y <= iz.maxY + 0.35
      ) {
        return true;
      }
    }
    return false;
  }

  private pickAdjacentWeather(current: ActiveWeatherConditionId): ActiveWeatherConditionId {
    const idx = WEATHER_ORDER.indexOf(current);
    if (idx < 0) return 'clear';
    const candidates: ActiveWeatherConditionId[] = [];
    if (idx > 0) candidates.push(WEATHER_ORDER[idx - 1]);
    if (idx < WEATHER_ORDER.length - 1) candidates.push(WEATHER_ORDER[idx + 1]);
    return candidates[Math.floor(Math.random() * candidates.length)] ?? 'clear';
  }

  public update(dt: number, cameraPos: Readonly<THREE.Vector3>, isAuthoritative = true): void {
    const safeDt = Math.max(0, Math.min(0.1, dt));
    this.elapsedSec += safeDt;

    if (!this.supportsDynamicWeatherTime) {
      // Static indoor maps (e.g. Kino) only need mild indoor silence for wind
      this.audio?.setWindWeather?.(0.5, 0.05, 0);
      return;
    }

    // 1. Advance 5x game clock (1m real = 5m game)
    if (isAuthoritative) {
      this.gameTimeHours = (this.gameTimeHours + safeDt * GAME_HOURS_PER_REAL_SEC) % 24;

      // 2. Dynamic weather state machine with >= 5 min lock when explicit preset selected
      if (this.transitionAlpha < 1) {
        this.transitionAlpha = Math.min(1, this.transitionAlpha + safeDt / WEATHER_TRANSITION_SEC);
        if (this.transitionAlpha >= 1) {
          this.activeWeather = this.targetWeather;
          this.weatherHoldTimerSec = 0;
          this.nextHoldDurationSec =
            this.weatherPreset === 'auto'
              ? 85 + Math.random() * 115
              : 110 + Math.random() * 120;
        }
      } else {
        this.weatherHoldTimerSec += safeDt;
        if (this.weatherHoldTimerSec >= this.nextHoldDurationSec) {
          const next = this.pickAdjacentWeather(this.activeWeather);
          if (next !== this.activeWeather) {
            this.targetWeather = next;
            this.transitionAlpha = 0;
          } else {
            this.weatherHoldTimerSec = 0;
          }
        }
      }
    }

    // Blend current & target specs cleanly
    const fromSpec = WEATHER_SPECS[this.activeWeather];
    const toSpec = WEATHER_SPECS[this.targetWeather];
    const blend = this.transitionAlpha;

    const windMin = THREE.MathUtils.lerp(fromSpec.windMinMps, toSpec.windMinMps, blend);
    const windMax = THREE.MathUtils.lerp(fromSpec.windMaxMps, toSpec.windMaxMps, blend);
    const gustStrength = THREE.MathUtils.lerp(fromSpec.gustStrength, toSpec.gustStrength, blend);
    const targetRain = THREE.MathUtils.lerp(fromSpec.rainDensity, toSpec.rainDensity, blend);
    const fogScale = THREE.MathUtils.lerp(fromSpec.fogScale, toSpec.fogScale, blend);
    const sunDim = THREE.MathUtils.lerp(fromSpec.sunDim, toSpec.sunDim, blend);
    const cloudMute = THREE.MathUtils.lerp(fromSpec.cloudMute, toSpec.cloudMute, blend);

    // 3. Natural fluctuating wind curve (so wind isn't monotonic/constant)
    this.windAngleRad += Math.sin(this.elapsedSec * 0.043) * 0.008 * safeDt;
    this.windDirection.set(Math.cos(this.windAngleRad), Math.sin(this.windAngleRad)).normalize();

    const waveA = Math.sin(this.elapsedSec * 0.17 + 0.4) * 0.5 + 0.5;
    const waveB = Math.sin(this.elapsedSec * 0.41 + 2.1) * 0.5 + 0.5;
    const waveC = Math.sin(this.elapsedSec * 0.93 + 4.7) * 0.5 + 0.5;
    const rawGust = Math.pow(waveA * 0.52 + waveB * 0.34 + waveC * 0.14, 1.35);
    this.windGust01 = THREE.MathUtils.clamp(rawGust * (0.35 + gustStrength * 0.65), 0, 1);
    this.windSpeedMps = THREE.MathUtils.lerp(windMin, windMax, this.windGust01);
    this.rainIntensity = targetRain;

    // 4. Wetness accumulation (rises smoothly in rain, dries slowly when clear)
    if (this.rainIntensity > 0.12) {
      this.wetness = Math.min(1, this.wetness + safeDt * (0.045 * this.rainIntensity));
    } else {
      const dryRate = this.activeWeather === 'sunny' ? 0.022 : 0.011;
      this.wetness = Math.max(0, this.wetness - safeDt * dryRate);
    }

    // 5. Thunder & lightning during stormy weather
    if (this.rainIntensity > 0.82 && isAuthoritative) {
      this.lightningTimerSec -= safeDt;
      if (this.lightningTimerSec <= 0) {
        this.lightningFlash = 1.0;
        this.pendingThunderDelaySec = 0.6 + Math.random() * 1.9;
        this.pendingThunderIntensity = 0.65 + Math.random() * 0.35;
        this.lightningTimerSec = 9 + Math.random() * 17;
      }
    }
    if (this.lightningFlash > 0) {
      this.lightningFlash = Math.max(0, this.lightningFlash - safeDt * 4.8);
    }
    if (this.pendingThunderDelaySec >= 0) {
      this.pendingThunderDelaySec -= safeDt;
      if (this.pendingThunderDelaySec <= 0) {
        this.pendingThunderDelaySec = -1;
        this.audio?.playThunder?.(this.pendingThunderIntensity);
      }
    }

    // 6. Sun / Moon 24-hour orbital lighting arc
    this.applySolarLunarLighting(fromSpec, toSpec, blend, fogScale, sunDim, cloudMute);

    // 7. Push uniforms to wind foliage, river water, wet materials, and Web Audio
    const windShaderNorm = THREE.MathUtils.clamp(this.windSpeedMps / 15.0, 0.06, 1.6);
    if (this.windUniforms) {
      this.windUniforms.uTime.value = this.elapsedSec;
      this.windUniforms.uWindDir.value.copy(this.windDirection);
      this.windUniforms.uWindStrength.value = windShaderNorm;
      this.windUniforms.uGustFreq.value = 0.55 + this.windGust01 * 0.95;
      this.windUniforms.uWetness.value = this.wetness;
    }

    if (this.waterUniforms) {
      this.waterUniforms.uTime.value = this.elapsedSec;
      this.waterUniforms.uWindDir.value.copy(this.windDirection);
      this.waterUniforms.uWindStrength.value = windShaderNorm;
      this.waterUniforms.uSunDir.value.copy(this.sunDirection);
      this.waterUniforms.uSunColor.value.copy(this.keyLight.color);
      this.waterUniforms.uSunIntensity.value = this.keyLight.intensity;
      this.waterUniforms.uSkyColor.value.copy(_tmpSkyColor);
      this.waterUniforms.uHorizonColor.value.copy(_tmpHorizonColor);
      this.waterUniforms.fogColor.value.copy(_tmpFogColor);
      if (this.scene.fog instanceof THREE.FogExp2) {
        this.waterUniforms.fogDensity.value = this.scene.fog.density;
      }
    }

    if (this.wettableSurfaces.length > 0) {
      for (let i = 0; i < this.wettableSurfaces.length; i++) {
        const entry = this.wettableSurfaces[i];
        entry.material.roughness = THREE.MathUtils.lerp(
          entry.baseRoughness,
          Math.max(0.14, entry.baseRoughness * 0.42),
          this.wetness,
        );
        entry.material.envMapIntensity = THREE.MathUtils.lerp(
          entry.baseEnvMapIntensity,
          entry.baseEnvMapIntensity * 1.45,
          this.wetness,
        );
      }
    }

    this.audio?.setWindWeather?.(this.windSpeedMps, this.windGust01, this.rainIntensity);

    // 8. Rain streaks particle volume around camera (skipping sheltered interior zones)
    this.updateRainParticles(safeDt, cameraPos);
  }

  private applySolarLunarLighting(
    fromSpec: WeatherVisualSpec,
    toSpec: WeatherVisualSpec,
    blend: number,
    fogScale: number,
    sunDim: number,
    cloudMute: number,
  ): void {
    // Convert hours -> solar elevation: 06:00 sunrise (0), 12:30 peak (+1), 19:00 sunset (0), 00:00 nadir (-1)
    const sunCycleRad = ((this.gameTimeHours - 6.0) / 24.0) * Math.PI * 2.0;
    const rawSin = Math.sin(sunCycleRad);
    const sunElevRad = Math.asin(THREE.MathUtils.clamp(rawSin * 0.88, -0.95, 0.95));
    const azimuthRad = ((this.gameTimeHours - 6.0) / 24.0) * Math.PI * 2.0 + 0.42;

    const isDay = rawSin > -0.05;
    const nightWeight = THREE.MathUtils.smoothstep(-rawSin, -0.14, 0.24);
    const dayWeight = 1.0 - nightWeight;
    const goldenHour = Math.exp(-Math.pow(rawSin * 4.2, 2.0));

    // Active orbital body direction (sun during day, moon opposite during night)
    if (isDay) {
      this.sunDirection.set(
        Math.cos(azimuthRad) * Math.cos(sunElevRad),
        Math.max(0.06, Math.sin(sunElevRad)),
        Math.sin(azimuthRad) * Math.cos(sunElevRad),
      ).normalize();
    } else {
      const moonElev = Math.max(0.18, Math.abs(Math.sin(sunElevRad)) * 0.85);
      this.sunDirection.set(
        -Math.cos(azimuthRad) * Math.cos(moonElev),
        moonElev,
        -Math.sin(azimuthRad) * Math.cos(moonElev),
      ).normalize();
    }

    // Position directional shadow light only when sun/moon direction moves measurably (prevents shadow texel shimmer)
    if (this.lastKeyLightDir.lengthSq() < 0.5 || this.lastKeyLightDir.dot(this.sunDirection) < 0.999996) {
      this.lastKeyLightDir.copy(this.sunDirection);
      this.keyLight.position.copy(this.sunDirection).multiplyScalar(92);
    }

    // Sun vs Moon color & intensity (zero per-frame heap allocations)
    _tmpSunColor.setHex(0xfff5e4).lerp(_colGoldenSun, goldenHour * (1 - cloudMute * 0.65));
    if (!isDay) {
      _tmpSunColor.lerp(_colMoonBlue, nightWeight);
    }

    const dayLightAmp = THREE.MathUtils.clamp((rawSin + 0.12) / 0.85, 0, 1);
    const moonBaseInt = 0.22 * (1 - cloudMute * 0.55);
    const keyInt =
      THREE.MathUtils.lerp(moonBaseInt, 2.35 * sunDim * (0.28 + 0.72 * dayLightAmp), dayWeight) +
      this.lightningFlash * 3.4;

    this.keyLight.color.copy(_tmpSunColor);
    if (this.lightningFlash > 0.05) {
      this.keyLight.color.lerp(_colLightningWhite, this.lightningFlash * 0.85);
    }
    this.keyLight.intensity = keyInt;

    // Blend day/night sky & horizon colors from active & target weather
    _tmpFromSky.copy(fromSpec.skyTopDay).lerp(fromSpec.skyTopNight, nightWeight);
    _tmpToSky.copy(toSpec.skyTopDay).lerp(toSpec.skyTopNight, nightWeight);
    _tmpSkyColor.copy(_tmpFromSky).lerp(_tmpToSky, blend);

    _tmpFromHoriz.copy(fromSpec.skyHorizonDay).lerp(fromSpec.skyHorizonNight, nightWeight);
    _tmpToHoriz.copy(toSpec.skyHorizonDay).lerp(toSpec.skyHorizonNight, nightWeight);
    _tmpHorizonColor.copy(_tmpFromHoriz).lerp(_tmpToHoriz, blend);

    if (goldenHour > 0.02 && dayWeight > 0.15) {
      _tmpHorizonColor.lerp(_colWarmHorizon, goldenHour * 0.42 * (1 - cloudMute * 0.75));
    }

    if (this.lightningFlash > 0.02) {
      _tmpSkyColor.lerp(_colLightningSky, this.lightningFlash * 0.55);
      _tmpHorizonColor.lerp(_colLightningSky, this.lightningFlash * 0.65);
    }

    // Hemisphere ambient: night drops deeply so NVGs & IR illuminators feel authentic!
    const nightHemiBase = 0.12 * (1 - cloudMute * 0.42);
    const dayHemiBase = 0.94 * (0.48 + 0.52 * sunDim);
    this.hemiLight.color.copy(_tmpSkyColor);
    _tmpGroundColor.setHex(0x3a4032).lerp(_colNightGround, nightWeight);
    this.hemiLight.groundColor.copy(_tmpGroundColor);
    this.hemiLight.intensity = THREE.MathUtils.lerp(nightHemiBase, dayHemiBase, dayWeight) + this.lightningFlash * 0.8;

    // Scene background, fog & environment reflections
    _tmpFogColor.copy(_tmpHorizonColor);
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(_tmpFogColor);
    } else {
      this.scene.background = _tmpFogColor.clone();
    }

    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(_tmpFogColor);
      this.scene.fog.density = this.baseFogDensity * fogScale * THREE.MathUtils.lerp(1.38, 1.0, dayWeight);
    }

    this.scene.environmentIntensity =
      this.baseEnvIntensity * THREE.MathUtils.lerp(0.11, 0.35 + 0.65 * sunDim, dayWeight);
    if (this.renderer.toneMapping !== THREE.NoToneMapping) {
      this.renderer.toneMappingExposure = THREE.MathUtils.lerp(0.86, 1.0, dayWeight);
    }

    // Activate map streetlamps / runway beacons smoothly as dusk arrives (skip shot-out fixtures until repaired)
    const lampAlpha = THREE.MathUtils.smoothstep(nightWeight, 0.25, 0.75);
    for (let i = 0; i < this.nightLights.length; i++) {
      const nl = this.nightLights[i];
      if (nl.light && nl.baseLightIntensity !== undefined) {
        if (nl.light.userData?.electronicBroken) {
          nl.light.intensity = 0;
          nl.light.visible = false;
        } else {
          const nextIntensity = nl.baseLightIntensity * lampAlpha;
          nl.light.intensity = nextIntensity;
          nl.light.visible = nextIntensity > 0.01;
        }
      }
      if (nl.emissiveMat && nl.baseEmissiveIntensity !== undefined) {
        if (nl.emissiveMat.userData?.electronicBroken) {
          nl.emissiveMat.emissiveIntensity = 0;
        } else {
          nl.emissiveMat.emissiveIntensity = THREE.MathUtils.lerp(0.08, nl.baseEmissiveIntensity, lampAlpha);
        }
      }
    }
  }

  private updateRainParticles(dt: number, cameraPos: Readonly<THREE.Vector3>): void {
    if (!this.rainMesh || !this.rainMat) return;
    if (this.rainIntensity <= 0.04) {
      this.rainMesh.visible = false;
      this.rainMesh.count = 0;
      return;
    }

    const activeCount = Math.min(this.maxRainCount, Math.floor(this.maxRainCount * this.rainIntensity));
    this.rainMesh.visible = activeCount > 0;
    this.rainMat.opacity = 0.16 + this.rainIntensity * 0.22;

    const windVx = this.windDirection.x * this.windSpeedMps * 0.38;
    const windVz = this.windDirection.y * this.windSpeedMps * 0.38;
    const extent = this.rainHalfExtent;
    const span = extent * 2;
    const height = this.rainHeight;
    const minY = Math.max(-1.0, cameraPos.y - 3.5);

    _rainTilt.set(-windVx, -18.5, -windVz).normalize();
    _tmpQuat.setFromUnitVectors(_rainUp, _rainTilt);

    let visibleIdx = 0;
    for (let i = 0; i < activeCount; i++) {
      const drop = this.rainDrops[i];
      drop.x += windVx * dt;
      drop.z += windVz * dt;
      drop.y -= drop.speed * dt;

      // Wrap relative to camera position so rain always stays dense in player's local sphere
      const dx = drop.x - cameraPos.x;
      const dz = drop.z - cameraPos.z;
      if (dx > extent) drop.x -= span;
      else if (dx < -extent) drop.x += span;
      if (dz > extent) drop.z -= span;
      else if (dz < -extent) drop.z += span;

      if (drop.y < minY) {
        drop.x = cameraPos.x + (Math.random() * 2 - 1) * extent;
        drop.z = cameraPos.z + (Math.random() * 2 - 1) * extent;
        drop.y = cameraPos.y + 4.5 + Math.random() * (height - 4.5);
      }

      if (this.isInsideRoof(drop.x, drop.y, drop.z)) {
        continue;
      }

      _tmpPos.set(drop.x, drop.y, drop.z);
      _tmpScale.set(1, drop.length * (0.8 + this.rainIntensity * 0.65), 1);
      _tmpMatrix.compose(_tmpPos, _tmpQuat, _tmpScale);
      this.rainMesh.setMatrixAt(visibleIdx, _tmpMatrix);
      visibleIdx++;
    }

    this.rainMesh.count = visibleIdx;
    this.rainMesh.instanceMatrix.needsUpdate = true;
  }

  public getGameTimeHours(): number {
    return this.gameTimeHours;
  }

  public getFormattedClock(): string {
    const wrapped = ((this.gameTimeHours % 24) + 24) % 24;
    const hh = Math.floor(wrapped);
    const mm = Math.floor((wrapped - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  public getActiveWeather(): ActiveWeatherConditionId {
    return this.transitionAlpha > 0.5 ? this.targetWeather : this.activeWeather;
  }

  public getWindSpeedMps(): number {
    return this.windSpeedMps;
  }

  public getWindAngleRad(): number {
    return this.windAngleRad;
  }

  public getWetness(): number {
    return this.wetness;
  }

  /** Approximate outdoor ambient illumination factor [0.06 night overcast .. 1.0 bright noon] */
  public getAmbientLightLevel(): number {
    const sunSin = Math.sin(((this.gameTimeHours - 6.0) / 24.0) * Math.PI * 2.0);
    const dayFrac = THREE.MathUtils.smoothstep(sunSin, -0.18, 0.28);
    const spec = WEATHER_SPECS[this.getActiveWeather()];
    return THREE.MathUtils.clamp(THREE.MathUtils.lerp(0.05, spec.sunDim * 0.92, dayFrac), 0.04, 1.0);
  }

  public getSyncState(): WeatherEnvSyncState {
    return {
      activeWeather: this.activeWeather,
      targetWeather: this.targetWeather,
      transitionAlpha: Number(this.transitionAlpha.toFixed(3)),
      gameTimeHours: Number(this.gameTimeHours.toFixed(4)),
      windAngleRad: Number(this.windAngleRad.toFixed(3)),
      windSpeedMps: Number(this.windSpeedMps.toFixed(2)),
      wetness: Number(this.wetness.toFixed(3)),
    };
  }

  public applyHostSyncState(state: WeatherEnvSyncState): void {
    this.activeWeather = state.activeWeather;
    this.targetWeather = state.targetWeather;
    this.transitionAlpha = THREE.MathUtils.clamp(state.transitionAlpha, 0, 1);
    this.gameTimeHours = ((state.gameTimeHours % 24) + 24) % 24;
    this.windAngleRad = state.windAngleRad;
    this.wetness = THREE.MathUtils.clamp(state.wetness, 0, 1);
  }

  public dispose(): void {
    if (this.rainMesh) {
      this.scene.remove(this.rainMesh);
      this.rainMesh.dispose();
      this.rainMesh = null;
    }
    this.rainGeo?.dispose();
    this.rainMat?.dispose();
    this.rainGeo = null;
    this.rainMat = null;
  }
}

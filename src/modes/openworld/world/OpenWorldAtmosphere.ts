import * as THREE from 'three';
import type { OpenWorldWeatherId } from '../types';

/**
 * Full 24-hour world cycle spans 90 real-time minutes (5,400 seconds) per specification.
 */
export const OPENWORLD_DAY_CYCLE_SECONDS = 5400; // 90 minutes

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
}

const WEATHER_LABELS: Readonly<Record<OpenWorldWeatherId, string>> = {
  clear: 'Clear',
  coastal_fog: 'Coastal Fog',
  mountain_rain: 'Mountain Rain',
};

const _skyZenith = new THREE.Color();
const _skyHorizon = new THREE.Color();
const _fogColor = new THREE.Color();
const _sunColor = new THREE.Color();
const _hemiSky = new THREE.Color();
const _hemiGround = new THREE.Color();
const _sunDir = new THREE.Vector3();

const _dayZenith = new THREE.Color(0x2d5e96);
const _dayHorizon = new THREE.Color(0x9ab8d4);
const _duskZenith = new THREE.Color(0x1c2541);
const _duskHorizon = new THREE.Color(0xd97d48);
const _nightZenith = new THREE.Color(0x050914);
const _nightHorizon = new THREE.Color(0x101a2e);
const _fogOvercast = new THREE.Color(0x6e7b84);
const _rainOvercast = new THREE.Color(0x3b4652);

const _daySunColor = new THREE.Color(0xfff1dc);
const _duskSunColor = new THREE.Color(0xff9452);
const _moonColor = new THREE.Color(0x88a8dc);

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
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform float uSunIntensity;
  uniform float uNightFactor;
  uniform float uOvercast;
  varying vec3 vWorldDir;

  float starHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  void main() {
    vec3 dir = normalize(vWorldDir);
    float up = clamp(dir.y, 0.0, 1.0);
    float horizonPow = pow(1.0 - up, 2.4);
    vec3 col = mix(uZenithColor, uHorizonColor, horizonPow);

    // Sun / moon glow & disc
    float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
    float glow = pow(sunDot, 12.0) * 0.32 * uSunIntensity * (1.0 - uOvercast * 0.72);
    float disc = smoothstep(0.9982, 0.9994, sunDot) * 1.45 * uSunIntensity * (1.0 - uOvercast * 0.85);
    col += uSunColor * (glow + disc);

    // Crisp procedural starfield on clear nights
    if (uNightFactor > 0.15 && up > 0.08 && uOvercast < 0.65) {
      vec3 grid = floor(dir * 260.0);
      float h = starHash(grid);
      float star = smoothstep(0.9968, 0.9996, h) * uNightFactor * (1.0 - uOvercast) * smoothstep(0.08, 0.32, up);
      col += vec3(0.85, 0.92, 1.0) * star * 0.9;
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

/**
 * Dynamic 90-minute Day/Night Cycle & Regional Weather Atmosphere Controller.
 * - Zero per-frame heap allocations.
 * - Dynamically scales `aiVisionConeMultiplier`, fog density, sky shader, and shadow-casting sun/moon.
 * - Lightweight rain streak curtain for `mountain_rain`.
 */
export class OpenWorldAtmosphere {
  public readonly sunLight: THREE.DirectionalLight;
  public readonly hemiLight: THREE.HemisphereLight;
  public readonly skyDome: THREE.Mesh;
  public readonly fog: THREE.FogExp2;

  private readonly scene: THREE.Scene;
  private readonly isSoftwareGl: boolean;
  private readonly skyMaterial: THREE.ShaderMaterial;
  private readonly rainPoints: THREE.Points;
  private readonly rainPositions: Float32Array;
  private readonly rainCount = 900;

  private timeOfDayHours = 9.5; // Crisp morning start
  private weather: OpenWorldWeatherId = 'clear';
  private timeScale = 1; // 1 = real 90-minute 24h cycle
  private paused = false;

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
  };

  constructor(scene: THREE.Scene, isSoftwareGl: boolean) {
    this.scene = scene;
    this.isSoftwareGl = isSoftwareGl;

    this.fog = new THREE.FogExp2(0x9ab8d4, 0.00042);
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

    // Procedural sky dome (follows camera position, zero depth write)
    const skyGeo = new THREE.SphereGeometry(4800, 24, 16);
    this.skyMaterial = new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: SKY_FRAGMENT_SHADER,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenithColor: { value: _dayZenith.clone() },
        uHorizonColor: { value: _dayHorizon.clone() },
        uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.5).normalize() },
        uSunColor: { value: _daySunColor.clone() },
        uSunIntensity: { value: 1.0 },
        uNightFactor: { value: 0.0 },
        uOvercast: { value: 0.0 },
      },
    });
    this.skyDome = new THREE.Mesh(skyGeo, this.skyMaterial);
    this.skyDome.frustumCulled = false;
    this.skyDome.renderOrder = -10;
    this.scene.add(this.skyDome);

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
      opacity: 0.52,
      depthWrite: false,
    });
    this.rainPoints = new THREE.Points(rainGeo, rainMat);
    this.rainPoints.visible = false;
    this.rainPoints.frustumCulled = false;
    this.scene.add(this.rainPoints);

    this.applyLightingAndTelemetry(0, 0, 0);
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

  public setWeather(weather: OpenWorldWeatherId): void {
    this.weather = weather;
    this.applyLightingAndTelemetry(
      this.skyDome.position.x,
      this.skyDome.position.y,
      this.skyDome.position.z,
    );
  }

  public setTimeScale(scale: number): void {
    this.timeScale = Math.max(0, Math.min(360, scale));
    this.paused = this.timeScale === 0;
    this.telemetry.timeScale = this.timeScale;
  }

  public getTelemetry(): Readonly<AtmosphereTelemetry> {
    return this.telemetry;
  }

  /**
   * Advances the 90-minute day/night cycle and updates lighting, sky dome, fog, and rain.
   * Zero heap allocations per frame.
   */
  public update(dt: number, anchorX: number, anchorY: number, anchorZ: number): void {
    const safeDt = Math.min(0.1, Math.max(0, dt));
    if (!this.paused && this.timeScale > 0) {
      // 24 game-hours per OPENWORLD_DAY_CYCLE_SECONDS (5400s = 90 min)
      const hoursPerSec = 24 / OPENWORLD_DAY_CYCLE_SECONDS;
      this.timeOfDayHours = (this.timeOfDayHours + safeDt * hoursPerSec * this.timeScale) % 24;
    }

    this.skyDome.position.set(anchorX, anchorY, anchorZ);
    this.applyLightingAndTelemetry(anchorX, anchorY, anchorZ);

    // Update rain curtain when Mountain Rain is active
    const rainActive = this.weather === 'mountain_rain';
    this.rainPoints.visible = rainActive;
    if (rainActive) {
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
    const twilightPeak = Math.max(0, 1.0 - Math.abs(sunSin - 0.04) / 0.24);
    const nightFactor = 1.0 - THREE.MathUtils.clamp((sunSin + 0.14) / 0.28, 0, 1);

    const overcast =
      this.weather === 'mountain_rain' ? 0.78 : this.weather === 'coastal_fog' ? 0.56 : 0.0;

    // Sky & horizon gradient
    _skyZenith.copy(_nightZenith).lerp(_dayZenith, dayFactor);
    _skyHorizon.copy(_nightHorizon).lerp(_dayHorizon, dayFactor);
    _skyZenith.lerp(_duskZenith, twilightPeak * 0.55);
    _skyHorizon.lerp(_duskHorizon, twilightPeak * 0.72);

    if (this.weather === 'coastal_fog') {
      _skyZenith.lerp(_fogOvercast, 0.55 * (0.25 + dayFactor * 0.75));
      _skyHorizon.lerp(_fogOvercast, 0.78 * (0.25 + dayFactor * 0.75));
    } else if (this.weather === 'mountain_rain') {
      _skyZenith.lerp(_rainOvercast, 0.72 * (0.25 + dayFactor * 0.75));
      _skyHorizon.lerp(_rainOvercast, 0.85 * (0.25 + dayFactor * 0.75));
    }

    // Active celestial direction (sun by day, moon opposite arc at night)
    if (sunSin >= -0.08) {
      _sunDir.set(sunCos * 0.82, Math.max(0.06, sunSin), -0.45).normalize();
      _sunColor.copy(_duskSunColor).lerp(_daySunColor, THREE.MathUtils.clamp(sunSin * 2.5, 0, 1));
      const weatherDim = 1.0 - overcast * 0.52;
      this.sunLight.intensity = THREE.MathUtils.lerp(0.28, 2.35, dayFactor) * weatherDim;
    } else {
      _sunDir.set(-sunCos * 0.75, Math.max(0.18, -sunSin * 0.85), 0.42).normalize();
      _sunColor.copy(_moonColor);
      this.sunLight.intensity = 0.26 * (1.0 - overcast * 0.45);
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
    this.hemiLight.intensity = THREE.MathUtils.lerp(0.22, 0.92, dayFactor) * (1.0 - overcast * 0.2);

    // Horizon-matched FogExp2
    _fogColor.copy(_skyHorizon);
    this.fog.color.copy(_fogColor);
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.copy(_fogColor);
    }

    const baseFog =
      this.weather === 'coastal_fog'
        ? 0.0021
        : this.weather === 'mountain_rain'
          ? 0.00145
          : 0.00038;
    this.fog.density = baseFog * (1.0 + nightFactor * 0.22);

    // Push sky shader uniforms
    const u = this.skyMaterial.uniforms;
    (u.uZenithColor.value as THREE.Color).copy(_skyZenith);
    (u.uHorizonColor.value as THREE.Color).copy(_skyHorizon);
    (u.uSunDir.value as THREE.Vector3).copy(_sunDir);
    (u.uSunColor.value as THREE.Color).copy(_sunColor);
    u.uSunIntensity.value = sunSin >= -0.08 ? 0.35 + dayFactor * 0.75 : 0.35;
    u.uNightFactor.value = nightFactor;
    u.uOvercast.value = overcast;

    // Gameplay telemetry: AI vision cone scaling & covert night ops indicator
    const weatherVisMult =
      this.weather === 'coastal_fog' ? 0.52 : this.weather === 'mountain_rain' ? 0.68 : 1.0;
    const lightVisMult = THREE.MathUtils.lerp(0.42, 1.0, dayFactor);
    const aiVisionConeMultiplier = Math.max(
      0.25,
      Math.min(1.0, Math.round(lightVisMult * weatherVisMult * 100) / 100),
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
  }

  public dispose(): void {
    this.scene.remove(this.sunLight);
    this.scene.remove(this.sunLight.target);
    this.scene.remove(this.hemiLight);
    this.scene.remove(this.skyDome);
    this.scene.remove(this.rainPoints);

    this.skyDome.geometry.dispose();
    this.skyMaterial.dispose();
    this.rainPoints.geometry.dispose();
    (this.rainPoints.material as THREE.Material).dispose();
  }
}

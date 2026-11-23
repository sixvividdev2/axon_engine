import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { characterRoster } from '../CharacterRoster';
import {
  BankruptcyStatus,
  CharacterDeathOutcome,
  getBankruptcyStatus,
  processCharacterDeath,
} from '../PermadeathService';
import { shardStore } from '../ShardStore';
import {
  CharacterSlotId,
  OpenWorldBiomeId,
  OpenWorldCharacter,
  OpenWorldWeatherId,
  PMC_FACTIONS,
} from '../types';
import { AtmosphereTelemetry, OpenWorldAtmosphere } from './OpenWorldAtmosphere';
import { OpenWorldChunkStreamer, StreamerStats } from './OpenWorldChunkStreamer';
import {
  createTerrainSample,
  getNearestLandmark,
  OPENWORLD_BIOMES,
  OPENWORLD_LANDMARKS,
  OpenWorldLandmarkSpec,
  SEA_LEVEL_M,
  WORLD_HALF_M,
} from './OpenWorldTerrain';

export type OpenWorldNavMode = 'foot' | 'recon_flight';

export interface OpenWorldSessionSnapshot {
  character: OpenWorldCharacter | null;
  bankruptcy: BankruptcyStatus | null;
  pointerLocked: boolean;
  navMode: OpenWorldNavMode;
  flashlightOn: boolean;
  worldX: number;
  worldY: number;
  worldZ: number;
  groundY: number;
  altitudeAglM: number;
  headingDeg: number;
  biomeId: OpenWorldBiomeId;
  biomeName: string;
  biomeElevationBand: string;
  nearestLandmarkName: string;
  nearestLandmarkDistM: number;
  atmosphere: AtmosphereTelemetry;
  streamer: StreamerStats;
  drawCalls: number;
  triangles: number;
  frameTimeMs: number;
  fps: number;
  shardCorpseCount: number;
  lastDeathOutcome: CharacterDeathOutcome | null;
}

type SnapshotListener = (snap: OpenWorldSessionSnapshot) => void;

// Module-scope zero-GC scratch objects
const _terrainScratch = createTerrainSample();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _moveVec = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _flashTargetPos = new THREE.Vector3();

function detectSoftwareWebGl(): boolean {
  if (typeof document === 'undefined') return true;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

/**
 * Interactive 4km × 4km 4-Biome Open World Session Engine.
 * - Strict isolation under `src/modes/openworld/world/`.
 * - Enforces <= 7.0ms frametime budget, <150 draw calls, zero per-frame allocations,
 *   and explicit `.dispose()` teardown on chunks and session exit.
 */
export class OpenWorldSessionEngine {
  private readonly container: HTMLElement;
  private readonly isSoftwareGl: boolean;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly envTexture: THREE.Texture | null;

  private readonly atmosphere: OpenWorldAtmosphere;
  private readonly streamer: OpenWorldChunkStreamer;
  private readonly flashlight: THREE.SpotLight;
  private readonly corpseMarkerGroup = new THREE.Group();
  private readonly corpseGeometries: THREE.BufferGeometry[] = [];
  private readonly corpseMaterials: THREE.Material[] = [];

  private readonly keysDown = new Set<string>();
  private readonly listeners = new Set<SnapshotListener>();

  private activeSlotId: CharacterSlotId | null = null;
  private navMode: OpenWorldNavMode = 'foot';
  private flashlightOn = false;
  private pointerLocked = false;
  private disposed = false;

  // Player kinematic state (zero-GC scalars)
  private posX = -1120;
  private posY = 34;
  private posZ = 680;
  private velY = 0;
  private yaw = 0.65;
  private pitch = -0.06;
  private grounded = true;
  private bobPhase = 0;

  // Timing & telemetry
  private frameHandle = 0;
  private lastNowMs = 0;
  private smoothFrameMs = 8.0;
  private hudEmitAccum = 0;
  private lastDeathOutcome: CharacterDeathOutcome | null = null;

  private unsubRoster: (() => void) | null = null;
  private unsubShards: (() => void) | null = null;

  constructor(container: HTMLElement, slotId?: CharacterSlotId | null) {
    this.container = container;
    this.isSoftwareGl = detectSoftwareWebGl();

    // Renderer configured per Three.js studio PBR + software WebGL guard
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2),
    );
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setSize(
      Math.max(1, container.clientWidth),
      Math.max(1, container.clientHeight),
    );
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      72,
      Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight),
      0.15,
      5400,
    );

    // Procedural Studio IBL via RoomEnvironment on every device
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const rt = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.envTexture = rt.texture;
    this.scene.environment = this.envTexture;
    pmrem.dispose();

    // Atmosphere (90m day/night cycle + regional weather) & 3-Ring Chunk Streamer
    this.atmosphere = new OpenWorldAtmosphere(this.scene, this.isSoftwareGl);
    this.streamer = new OpenWorldChunkStreamer(this.scene, this.isSoftwareGl);

    // Tactical Weapon-Mounted Flashlight for Night Ops & Coastal Fog
    this.flashlight = new THREE.SpotLight(0xfff4df, 0, 95, Math.PI * 0.21, 0.45, 1.4);
    this.flashlight.castShadow = false;
    this.scene.add(this.flashlight);
    this.scene.add(this.flashlight.target);

    this.corpseMarkerGroup.name = 'openworld_shard_corpses';
    this.scene.add(this.corpseMarkerGroup);

    // Resolve active character and deploy to faction FOB
    const targetChar =
      (slotId ? characterRoster.getCharacter(slotId) : null) ??
      characterRoster.getActiveCharacter();
    this.activeSlotId = targetChar?.slotId ?? null;

    if (targetChar) {
      characterRoster.setDeploymentState(targetChar.slotId, 'deployed');
      const fobId =
        targetChar.pmcFaction === 'pmc_bravo' ? 'landmark_fob_bravo' : 'landmark_fob_alpha';
      this.teleportToLandmark(fobId, false);
    } else {
      this.teleportToLandmark('landmark_fob_alpha', false);
    }

    this.rebuildShardCorpseMarkers();

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    this.bindEvents();
    this.unsubRoster = characterRoster.subscribe(() => {
      this.emitSnapshot();
    });
    this.unsubShards = shardStore.subscribe(() => {
      this.rebuildShardCorpseMarkers();
      this.emitSnapshot();
    });

    this.lastNowMs = performance.now();
    this.emitSnapshot();
    this.scheduleNextFrame();
  }

  private bindEvents(): void {
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
  }

  private unbindEvents(): void {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
  }

  private readonly onResize = (): void => {
    if (this.disposed) return;
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  };

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
  };

  private readonly onPointerLockChange = (): void => {
    this.pointerLocked = document.pointerLockElement === this.renderer.domElement;
    if (!this.pointerLocked) {
      this.keysDown.clear();
    }
    this.emitSnapshot();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    this.keysDown.add(e.code);

    if (e.code === 'KeyF') {
      this.toggleFlashlight();
    } else if (e.code === 'KeyV') {
      this.setNavMode(this.navMode === 'foot' ? 'recon_flight' : 'foot');
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keysDown.delete(e.code);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked) return;
    const sens = 0.0021;
    this.yaw -= e.movementX * sens;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - e.movementY * sens,
      -Math.PI * 0.46,
      Math.PI * 0.46,
    );
  };

  public requestPointerLock(): void {
    try {
      this.renderer.domElement.requestPointerLock?.();
    } catch {
      // Ignore pointer lock rejection in automated/headless environments
    }
  }

  public exitPointerLock(): void {
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock?.();
    }
  }

  public setNavMode(mode: OpenWorldNavMode): void {
    if (this.navMode === mode) return;
    this.navMode = mode;
    if (mode === 'recon_flight') {
      const ground = this.streamer.sampleGroundHeight(this.posX, this.posZ);
      this.posY = Math.max(this.posY, ground + 42);
      this.velY = 0;
      this.grounded = false;
    } else {
      const ground = Math.max(SEA_LEVEL_M + 0.4, this.streamer.sampleGroundHeight(this.posX, this.posZ));
      this.posY = ground + 1.72;
      this.velY = 0;
      this.grounded = true;
    }
    this.emitSnapshot();
  }

  public toggleFlashlight(): void {
    this.flashlightOn = !this.flashlightOn;
    this.emitSnapshot();
  }

  public setTimeOfDay(hours: number): void {
    this.atmosphere.setTimeOfDay(hours);
    this.emitSnapshot();
  }

  public setWeather(weather: OpenWorldWeatherId): void {
    this.atmosphere.setWeather(weather);
    this.emitSnapshot();
  }

  public setTimeScale(scale: number): void {
    this.atmosphere.setTimeScale(scale);
    this.emitSnapshot();
  }

  public teleportToLandmark(landmarkId: string, emit = true): void {
    const lm: OpenWorldLandmarkSpec =
      OPENWORLD_LANDMARKS.find((l) => l.id === landmarkId) ?? OPENWORLD_LANDMARKS[0];
    this.posX = lm.worldX;
    this.posZ = lm.worldZ + 26;
    this.streamer.update(this.posX, this.posZ);
    const ground = Math.max(SEA_LEVEL_M + 0.5, this.streamer.sampleGroundHeight(this.posX, this.posZ));
    this.posY = this.navMode === 'recon_flight' ? ground + 55 : ground + 1.72;
    this.velY = 0;
    this.grounded = this.navMode === 'foot';
    // Face toward landmark center
    this.yaw = Math.atan2(lm.worldX - this.posX, lm.worldZ - this.posZ) + Math.PI;
    this.pitch = this.navMode === 'recon_flight' ? -0.26 : -0.04;
    if (emit) this.emitSnapshot();
  }

  public commitExfilToHideout(): OpenWorldCharacter | null {
    if (!this.activeSlotId) return null;
    const updated = characterRoster.recordExfil(this.activeSlotId, 0);
    if (updated) {
      const nearest = getNearestLandmark(this.posX, this.posZ);
      shardStore.recordDiscreteTransition(
        updated.shardMode,
        'exfil',
        `${updated.callsign} exfilled safely near ${nearest.landmark.shortLabel}`,
      );
    }
    this.emitSnapshot();
    return updated;
  }

  public triggerFieldDeathAtCurrentPosition(hospitalId?: string): CharacterDeathOutcome | null {
    if (!this.activeSlotId) return null;
    const nearest = getNearestLandmark(this.posX, this.posZ);
    const outcome = processCharacterDeath(characterRoster, shardStore, {
      slotId: this.activeSlotId,
      hospitalId,
      worldX: Math.round(this.posX),
      worldZ: Math.round(this.posZ),
      sectorLabel: nearest.landmark.name,
      causeOfDeath: 'KIA · Perimeter Operations Field Engagement',
    });
    this.lastDeathOutcome = outcome;
    if (outcome?.outcome === 'permadeath_wiped') {
      this.activeSlotId = characterRoster.getActiveSlotId();
    }
    this.rebuildShardCorpseMarkers();
    this.emitSnapshot();
    return outcome;
  }

  private rebuildShardCorpseMarkers(): void {
    // Clean up previous corpse marker meshes
    while (this.corpseMarkerGroup.children.length > 0) {
      this.corpseMarkerGroup.remove(this.corpseMarkerGroup.children[0]);
    }
    for (const g of this.corpseGeometries) g.dispose();
    for (const m of this.corpseMaterials) m.dispose();
    this.corpseGeometries.length = 0;
    this.corpseMaterials.length = 0;

    const active = this.activeSlotId ? characterRoster.getCharacter(this.activeSlotId) : null;
    if (!active) return;
    const shard = shardStore.getShard(active.shardMode);
    if (shard.corpses.length === 0) return;

    const bagGeo = new THREE.BoxGeometry(1.1, 0.55, 0.75);
    const poleGeo = new THREE.CylinderGeometry(0.05, 0.05, 4.2, 6);
    const beaconGeo = new THREE.OctahedronGeometry(0.32, 0);
    const bagMat = new THREE.MeshStandardMaterial({ color: 0x3b352c, roughness: 0.85, metalness: 0.1 });
    const beaconMat = new THREE.MeshStandardMaterial({
      color: active.shardMode === 'PvPvE' ? 0xef4444 : 0x38bdf8,
      emissive: active.shardMode === 'PvPvE' ? 0x991b1b : 0x0369a1,
      emissiveIntensity: 1.0,
      roughness: 0.3,
    });
    this.corpseGeometries.push(bagGeo, poleGeo, beaconGeo);
    this.corpseMaterials.push(bagMat, beaconMat);

    for (const corpse of shard.corpses) {
      const y = Math.max(SEA_LEVEL_M + 0.2, this.streamer.sampleGroundHeight(corpse.worldX, corpse.worldZ));
      const g = new THREE.Group();
      g.position.set(corpse.worldX, y, corpse.worldZ);
      const bag = new THREE.Mesh(bagGeo, bagMat);
      bag.position.y = 0.28;
      const pole = new THREE.Mesh(poleGeo, bagMat);
      pole.position.y = 2.1;
      const beacon = new THREE.Mesh(beaconGeo, beaconMat);
      beacon.position.y = 4.4;
      g.add(bag, pole, beacon);
      this.corpseMarkerGroup.add(g);
    }
  }

  private scheduleNextFrame(): void {
    if (this.disposed) return;
    if (this.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.frameHandle = requestAnimationFrame(this.tick);
    }
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameHandle = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameHandle = window.setTimeout(cb, 80);
      }
    };
    this.frameHandle = window.setTimeout(poll, 5);
  }

  private readonly tick = (): void => {
    if (this.disposed) return;

    const now = performance.now();
    const rawDt = Math.max(0.001, (now - this.lastNowMs) * 0.001);
    const dt = Math.min(0.05, rawDt);
    this.lastNowMs = now;

    this.stepPlayerKinematics(dt);

    // Stream 3x3 active / 5x5 mid-range rings on chunk crossing
    this.streamer.update(this.posX, this.posZ);

    // Update 90-minute day/night lighting, sky dome, fog, and rain
    this.atmosphere.update(dt, this.posX, this.posY, this.posZ);

    // Position weapon flashlight along camera view vector (zero allocations)
    if (this.flashlightOn) {
      this.flashlight.intensity = 6.5;
      this.flashlight.position.set(this.posX, this.posY - 0.14, this.posZ);
      this.camera.getWorldDirection(_forward);
      _flashTargetPos.copy(this.flashlight.position).addScaledVector(_forward, 25);
      this.flashlight.target.position.copy(_flashTargetPos);
    } else {
      this.flashlight.intensity = 0;
    }

    const renderStart = performance.now();
    this.renderer.render(this.scene, this.camera);
    const renderElapsed = performance.now() - renderStart;
    this.smoothFrameMs = this.smoothFrameMs * 0.9 + Math.max(renderElapsed, rawDt * 1000) * 0.1;

    this.hudEmitAccum += rawDt;
    if (this.hudEmitAccum >= 0.14) {
      this.hudEmitAccum = 0;
      this.emitSnapshot();
    }

    this.scheduleNextFrame();
  };

  private stepPlayerKinematics(dt: number): void {
    // Allow arrow-key camera look even when not pointer-locked (accessible fallback)
    const turnSpeed = 1.65;
    if (this.keysDown.has('ArrowLeft')) this.yaw += turnSpeed * dt;
    if (this.keysDown.has('ArrowRight')) this.yaw -= turnSpeed * dt;
    if (this.keysDown.has('ArrowUp')) {
      this.pitch = Math.min(Math.PI * 0.45, this.pitch + turnSpeed * 0.7 * dt);
    }
    if (this.keysDown.has('ArrowDown')) {
      this.pitch = Math.max(-Math.PI * 0.45, this.pitch - turnSpeed * 0.7 * dt);
    }

    // Horizontal basis vectors (zero-GC)
    _forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.crossVectors(_forward, _worldUp).normalize();
    _moveVec.set(0, 0, 0);

    if (this.keysDown.has('KeyW')) _moveVec.add(_forward);
    if (this.keysDown.has('KeyS')) _moveVec.sub(_forward);
    if (this.keysDown.has('KeyD')) _moveVec.add(_right);
    if (this.keysDown.has('KeyA')) _moveVec.sub(_right);

    const hasHoriz = _moveVec.lengthSq() > 0.0001;
    if (hasHoriz) _moveVec.normalize();

    const sprinting = this.keysDown.has('ShiftLeft') || this.keysDown.has('ShiftRight');

    if (this.navMode === 'recon_flight') {
      const speed = sprinting ? 140 : 62;
      this.posX += _moveVec.x * speed * dt;
      this.posZ += _moveVec.z * speed * dt;

      let vMove = 0;
      if (this.keysDown.has('Space') || this.keysDown.has('KeyE')) vMove += 1;
      if (this.keysDown.has('KeyC') || this.keysDown.has('ControlLeft') || this.keysDown.has('KeyQ')) vMove -= 1;
      this.posY += vMove * (sprinting ? 85 : 42) * dt;

      // Clamp to 4km theater bounds and above ground surface
      this.posX = THREE.MathUtils.clamp(this.posX, -WORLD_HALF_M + 24, WORLD_HALF_M - 24);
      this.posZ = THREE.MathUtils.clamp(this.posZ, -WORLD_HALF_M + 24, WORLD_HALF_M - 24);
      const ground = Math.max(SEA_LEVEL_M, this.streamer.sampleGroundHeight(this.posX, this.posZ));
      this.posY = THREE.MathUtils.clamp(this.posY, ground + 4.5, 760);
    } else {
      // Tactical Foot Patrol grounded on active 3x3 heightfield collider
      const speed = sprinting ? 9.4 : 4.8;
      this.posX = THREE.MathUtils.clamp(
        this.posX + _moveVec.x * speed * dt,
        -WORLD_HALF_M + 24,
        WORLD_HALF_M - 24,
      );
      this.posZ = THREE.MathUtils.clamp(
        this.posZ + _moveVec.z * speed * dt,
        -WORLD_HALF_M + 24,
        WORLD_HALF_M - 24,
      );

      if (this.grounded && this.keysDown.has('Space')) {
        this.velY = 6.2;
        this.grounded = false;
      }

      this.velY -= 19.6 * dt;
      this.posY += this.velY * dt;

      const ground = Math.max(SEA_LEVEL_M + 0.35, this.streamer.sampleGroundHeight(this.posX, this.posZ));
      const eyeFloor = ground + 1.72;
      if (this.posY <= eyeFloor) {
        this.posY = eyeFloor;
        this.velY = 0;
        this.grounded = true;
      }

      if (hasHoriz && this.grounded) {
        this.bobPhase += dt * (sprinting ? 11.5 : 7.6);
      }
    }

    const bobOffset =
      this.navMode === 'foot' && this.grounded && hasHoriz
        ? Math.sin(this.bobPhase) * (sprinting ? 0.055 : 0.032)
        : 0;

    _euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.position.set(this.posX, this.posY + bobOffset, this.posZ);
    this.camera.quaternion.setFromEuler(_euler);
  }

  public getSnapshot(): OpenWorldSessionSnapshot {
    const character = this.activeSlotId ? characterRoster.getCharacter(this.activeSlotId) : null;
    const bankruptcy = character ? getBankruptcyStatus(character) : null;
    const groundY = this.streamer.sampleGroundHeight(this.posX, this.posZ);
    const biomeId = this.sampleBiomeAt(this.posX, this.posZ);
    const biomeMeta = OPENWORLD_BIOMES[biomeId];
    const nearest = getNearestLandmark(this.posX, this.posZ);
    const headingDeg = (((-this.yaw * 180) / Math.PI) % 360 + 360) % 360;
    const shardCorpseCount = character
      ? shardStore.getShard(character.shardMode).corpses.length
      : 0;

    return {
      character,
      bankruptcy,
      pointerLocked: this.pointerLocked,
      navMode: this.navMode,
      flashlightOn: this.flashlightOn,
      worldX: Math.round(this.posX),
      worldY: Math.round(this.posY * 10) / 10,
      worldZ: Math.round(this.posZ),
      groundY: Math.round(groundY * 10) / 10,
      altitudeAglM: Math.max(0, Math.round(this.posY - groundY)),
      headingDeg: Math.round(headingDeg),
      biomeId,
      biomeName: biomeMeta.name,
      biomeElevationBand: biomeMeta.elevationRangeLabel,
      nearestLandmarkName: nearest.landmark.name,
      nearestLandmarkDistM: Math.round(nearest.distanceM),
      atmosphere: { ...this.atmosphere.getTelemetry() },
      streamer: this.streamer.getStats(),
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      frameTimeMs: Math.round(this.smoothFrameMs * 10) / 10,
      fps: Math.round(1000 / Math.max(1, this.smoothFrameMs)),
      shardCorpseCount,
      lastDeathOutcome: this.lastDeathOutcome,
    };
  }

  private sampleBiomeAt(x: number, z: number): OpenWorldBiomeId {
    const h = this.streamer.sampleGroundHeight(x, z);
    _terrainScratch.height = h;
    if (h < 15 || (z > 1180 && h < 22)) return 'coastal_port_marsh';
    if (h < 120) return 'temperate_conifer_valley';
    if (h < 260) return 'highland_steppe_quarry';
    return 'alpine_ridge_dam';
  }

  public subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitSnapshot(): void {
    if (this.listeners.size === 0) return;
    const snap = this.getSnapshot();
    for (const fn of this.listeners) fn(snap);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    window.clearTimeout(this.frameHandle);
    this.exitPointerLock();
    this.unbindEvents();
    this.unsubRoster?.();
    this.unsubShards?.();
    this.listeners.clear();

    for (const g of this.corpseGeometries) g.dispose();
    for (const m of this.corpseMaterials) m.dispose();
    this.streamer.dispose();
    this.atmosphere.dispose();
    this.envTexture?.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}

export { PMC_FACTIONS };

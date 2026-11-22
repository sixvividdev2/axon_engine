import * as THREE from 'three';

export type AcousticKind =
  | 'footstep_crouch'
  | 'footstep_walk'
  | 'footstep_sprint'
  | 'landing'
  | 'vault_low'
  | 'mantle_heavy'
  | 'door'
  | 'dry_fire'
  | 'gunshot_suppressed'
  | 'gunshot_loud'
  | 'explosion'
  | 'glass_shatter'
  | 'impact';

export interface AcousticEvent {
  position: THREE.Vector3;
  radiusMeters: number;
  kind: AcousticKind;
  timestampMs: number;
}

interface DebugRing {
  mesh: THREE.Mesh;
  maxRadius: number;
  age: number;
  duration: number;
}

export type AcousticListener = (event: AcousticEvent) => void;

export class AcousticSystem {
  private listeners: AcousticListener[] = [];
  private debugGroup = new THREE.Group();
  private debugRings: DebugRing[] = [];
  private debugEnabled = false;
  private ringGeo = new THREE.RingGeometry(0.92, 1.0, 48);

  constructor(scene: THREE.Scene) {
    this.ringGeo.rotateX(-Math.PI / 2);
    this.debugGroup.visible = false;
    scene.add(this.debugGroup);
  }

  public setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;
    this.debugGroup.visible = enabled;
  }

  public subscribe(listener: AcousticListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  public emitNoise(position: THREE.Vector3, radiusMeters: number, kind: AcousticKind): void {
    if (radiusMeters <= 0) return;

    const event: AcousticEvent = {
      position: position.clone(),
      radiusMeters,
      kind,
      timestampMs: performance.now(),
    };

    for (const listener of this.listeners) {
      listener(event);
    }

    if (this.debugEnabled) {
      this.spawnDebugRing(position, radiusMeters, kind);
    }
  }

  private spawnDebugRing(position: THREE.Vector3, radiusMeters: number, kind: AcousticKind): void {
    const color =
      kind === 'gunshot_loud' || kind === 'explosion'
        ? 0xef4444
        : kind === 'gunshot_suppressed' || kind === 'door' || kind === 'glass_shatter'
          ? 0xf59e0b
          : 0x38bdf8;
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.75,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.ringGeo, mat);
    mesh.position.set(position.x, position.y + 0.08, position.z);
    mesh.scale.set(0.2, 1, 0.2);
    this.debugGroup.add(mesh);

    this.debugRings.push({
      mesh,
      maxRadius: radiusMeters,
      age: 0,
      duration: Math.min(1.6, 0.45 + radiusMeters * 0.008),
    });
  }

  public update(delta: number): void {
    for (let i = this.debugRings.length - 1; i >= 0; i--) {
      const r = this.debugRings[i];
      r.age += delta;
      const t = Math.min(1, r.age / r.duration);
      const currentR = 0.2 + (r.maxRadius - 0.2) * (1 - Math.pow(1 - t, 2));
      r.mesh.scale.set(currentR, 1, currentR);
      const mat = r.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = (1 - t) * 0.75;

      if (t >= 1) {
        this.debugGroup.remove(r.mesh);
        mat.dispose();
        this.debugRings.splice(i, 1);
      }
    }
  }

  public shiftOrigin(shiftX: number, shiftZ: number): void {
    for (const r of this.debugRings) {
      r.mesh.position.x -= shiftX;
      r.mesh.position.z -= shiftZ;
    }
  }

  public dispose(): void {
    for (const r of this.debugRings) {
      this.debugGroup.remove(r.mesh);
      (r.mesh.material as THREE.Material).dispose();
    }
    this.debugRings = [];
    this.ringGeo.dispose();
    this.listeners = [];
  }
}

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CharacterSkeleton } from '../CharacterSkeleton';
import { OperatorUniformId } from '../TacticalUniforms';
import { DEFAULT_OPERATOR_ID, OperatorGearConfig, OperatorId } from './OperatorTypes';
import {
  RigValidationMode,
  RigValidationReport,
  validateOperatorRig,
} from './RigParityValidator';

export interface LoadedOperatorRig {
  readonly operatorId: OperatorId;
  readonly requestedOperatorId: OperatorId;
  readonly source: 'procedural' | 'glb';
  readonly fallbackTriggered: boolean;
  readonly skeleton: CharacterSkeleton;
  readonly glbScene?: THREE.Group;
  readonly validationReport: RigValidationReport;
}

export interface OperatorLoadOptions {
  readonly maxAnisotropy?: number;
  readonly uniformId?: OperatorUniformId;
  readonly previewMode?: boolean;
  readonly validationMode?: RigValidationMode;
  readonly gear?: Partial<OperatorGearConfig>;
  /** Optional drop-in `.glb` URL for DCC SkinnedMesh assets conforming to OperatorRigContract */
  readonly glbUrl?: string | null;
}

interface GlbCacheEntry {
  scene: THREE.Group;
  validationReport: RigValidationReport;
}

/**
 * Unified Operator Asset Loader & Rig Validator Gateway.
 * - Instantiates validated upgraded procedural tactical rigs (`CharacterSkeleton`) for MALE / FEMALE
 * - Transparently supports drop-in `.glb` (`GLTFLoader` + `SkinnedMesh`) assets validated against the exact same `OperatorRigContract`
 * - Caches loaded `.glb` templates cleanly and enforces `STRICT` (throw) or `SAFE_FALLBACK` (log + fallback to `'MALE'`)
 */
export class OperatorAssetLoader {
  private readonly glbCache = new Map<string, GlbCacheEntry>();
  private gltfLoader: GLTFLoader | null = null;
  private readonly registeredGlbUrls = new Map<OperatorId, string>();

  public registerGlbAssetUrl(operatorId: OperatorId, url: string): void {
    this.registeredGlbUrls.set(operatorId, url);
  }

  public clearGlbAssetUrl(operatorId: OperatorId): void {
    this.registeredGlbUrls.delete(operatorId);
  }

  /**
   * Synchronous validated procedural rig builder (ideal for zero-latency FPS spawn & turntable swap).
   */
  public loadProceduralOperator(
    requestedOperatorId: OperatorId,
    options?: OperatorLoadOptions,
  ): LoadedOperatorRig {
    const maxAniso = options?.maxAnisotropy ?? 4;
    const uniformId = options?.uniformId ?? 'infection';
    const previewMode = options?.previewMode ?? false;
    const validationMode = options?.validationMode ?? 'SAFE_FALLBACK';

    const skeleton = new CharacterSkeleton(
      maxAniso,
      uniformId,
      requestedOperatorId,
      previewMode,
      options?.gear,
    );
    const report = validateOperatorRig(skeleton.root, requestedOperatorId, validationMode);

    if (report.valid) {
      return {
        operatorId: requestedOperatorId,
        requestedOperatorId,
        source: 'procedural',
        fallbackTriggered: false,
        skeleton,
        validationReport: report,
      };
    }

    // SAFE_FALLBACK path: log structured diagnostics and fall back to verified 'MALE'
    console.error('[OperatorAssetLoader] Rig contract validation failed — falling back to MALE', report);
    skeleton.dispose();

    const fallbackSkeleton = new CharacterSkeleton(
      maxAniso,
      uniformId,
      DEFAULT_OPERATOR_ID,
      previewMode,
      options?.gear,
    );
    const fallbackReport = validateOperatorRig(fallbackSkeleton.root, DEFAULT_OPERATOR_ID, 'SAFE_FALLBACK');
    return {
      operatorId: DEFAULT_OPERATOR_ID,
      requestedOperatorId,
      source: 'procedural',
      fallbackTriggered: true,
      skeleton: fallbackSkeleton,
      validationReport: fallbackReport,
    };
  }

  /**
   * Async loader supporting drop-in `.glb` (`SkinnedMesh`) operator rigs with automatic caching
   * and contract validation, seamlessly falling back to the upgraded procedural rig if no `.glb`
   * URL is configured or if `.glb` contract validation fails in `SAFE_FALLBACK` mode.
   */
  public async loadOperator(
    requestedOperatorId: OperatorId,
    options?: OperatorLoadOptions,
  ): Promise<LoadedOperatorRig> {
    const glbUrl = options?.glbUrl ?? this.registeredGlbUrls.get(requestedOperatorId) ?? null;
    const validationMode = options?.validationMode ?? 'SAFE_FALLBACK';

    if (glbUrl) {
      try {
        const entry = await this.loadAndCacheGlb(glbUrl, requestedOperatorId, validationMode);
        if (entry.validationReport.valid) {
          const clonedScene = entry.scene.clone(true);
          const baseRig = this.loadProceduralOperator(requestedOperatorId, options);
          return {
            ...baseRig,
            source: 'glb',
            glbScene: clonedScene,
            validationReport: entry.validationReport,
          };
        }
      } catch (err) {
        if (validationMode === 'STRICT') {
          throw err;
        }
        console.error(`[OperatorAssetLoader] Drop-in GLB "${glbUrl}" failed validation/load — using fallback:`, err);
        if (requestedOperatorId !== DEFAULT_OPERATOR_ID) {
          const fb = this.loadProceduralOperator(DEFAULT_OPERATOR_ID, {
            ...options,
            validationMode: 'SAFE_FALLBACK',
          });
          return {
            ...fb,
            requestedOperatorId,
            fallbackTriggered: true,
          };
        }
      }
    }

    return this.loadProceduralOperator(requestedOperatorId, options);
  }

  private async loadAndCacheGlb(
    url: string,
    operatorId: OperatorId,
    validationMode: RigValidationMode,
  ): Promise<GlbCacheEntry> {
    const cached = this.glbCache.get(url);
    if (cached) return cached;

    if (!this.gltfLoader) {
      this.gltfLoader = new GLTFLoader();
    }

    const gltf = await this.gltfLoader.loadAsync(url);
    const root = gltf.scene;
    if (!root.name) {
      root.name = 'root';
    }
    const validationReport = validateOperatorRig(root, operatorId, validationMode);
    const entry: GlbCacheEntry = { scene: root, validationReport };
    if (validationReport.valid) {
      this.glbCache.set(url, entry);
    }
    return entry;
  }

  public clearCache(): void {
    this.glbCache.clear();
  }
}

export const operatorAssetLoader = new OperatorAssetLoader();

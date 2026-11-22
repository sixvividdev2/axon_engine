import { BodycamSurfaceMaterial } from '../bodycam-sdk/types';
import { BulletCoreType } from './calibers';

export type BallisticMaterialId = 'concrete' | 'steel' | 'wood' | 'dirt' | 'water' | 'glass';

export interface SurfaceMaterialBallistics {
  id: BallisticMaterialId;
  label: string;
  /** Maximum grazing angle (degrees from surface plane) where ricochet can occur at nominal speed */
  criticalRicochetDeg: number;
  /** Energy/momentum barrier scale per meter of thickness (higher = harder to punch through) */
  penetrationResistance: number;
  /** Base velocity retention multiplier on a clean grazing ricochet (0.30..0.65 typical) */
  elasticityRetention: number;
  /** Likelihood (0..1) of surface spall / bullet shattering when a high-velocity round stops hard */
  spallTendency: number;
  /** Default cover thickness in meters when mesh.userData.thicknessM is absent */
  defaultThicknessM: number;
}

export const BALLISTIC_MATERIALS: Record<BallisticMaterialId, SurfaceMaterialBallistics> = {
  concrete: {
    id: 'concrete',
    label: 'Concrete / Masonry',
    criticalRicochetDeg: 18,
    penetrationResistance: 95,
    elasticityRetention: 0.44,
    spallTendency: 0.78,
    defaultThicknessM: 0.24,
  },
  steel: {
    id: 'steel',
    label: 'Hardened Steel',
    criticalRicochetDeg: 28,
    penetrationResistance: 210,
    elasticityRetention: 0.62,
    spallTendency: 0.92,
    defaultThicknessM: 0.018,
  },
  wood: {
    id: 'wood',
    label: 'Timber / Plywood',
    criticalRicochetDeg: 8,
    penetrationResistance: 22,
    elasticityRetention: 0.34,
    spallTendency: 0.14,
    defaultThicknessM: 0.045,
  },
  dirt: {
    id: 'dirt',
    label: 'Dirt / Gravel',
    criticalRicochetDeg: 11,
    penetrationResistance: 58,
    elasticityRetention: 0.32,
    spallTendency: 0.22,
    defaultThicknessM: 0.45,
  },
  water: {
    id: 'water',
    label: 'Water Surface',
    criticalRicochetDeg: 12,
    penetrationResistance: 32,
    elasticityRetention: 0.48,
    spallTendency: 0.0,
    defaultThicknessM: 0.35,
  },
  glass: {
    id: 'glass',
    label: 'Tempered Glass',
    criticalRicochetDeg: 4,
    penetrationResistance: 6,
    elasticityRetention: 0.30,
    spallTendency: 0.08,
    defaultThicknessM: 0.014,
  },
};

export function mapSurfaceToBallisticMaterial(
  surface: BodycamSurfaceMaterial | string | undefined,
  userData?: Record<string, unknown>,
): BallisticMaterialId {
  const override = userData?.ballisticMaterial;
  if (
    override === 'concrete' ||
    override === 'steel' ||
    override === 'wood' ||
    override === 'dirt' ||
    override === 'water' ||
    override === 'glass'
  ) {
    return override;
  }
  switch (surface) {
    case 'metal':
      return 'steel';
    case 'wood':
      return 'wood';
    case 'puddle':
      return 'water';
    case 'glass':
      return 'glass';
    case 'gravel':
    case 'grass':
      return 'dirt';
    case 'concrete':
    case 'asphalt':
    default:
      return 'concrete';
  }
}

/**
 * Computes angle-and-velocity-scaled critical ricochet angle (degrees from surface tangent plane).
 * Hard AP / solid steel projectiles hold together and skip at steeper angles, whereas soft lead
 * slugs/JHP deform and splatter unless hitting very shallow.
 */
export function computeCriticalRicochetDeg(
  mat: SurfaceMaterialBallistics,
  coreType: BulletCoreType,
  speedMs: number,
): number {
  let coreMult = 1.0;
  switch (coreType) {
    case 'tungsten_ap':
    case 'solid_steel':
      coreMult = 1.18;
      break;
    case 'steel_core_ap':
      coreMult = 1.10;
      break;
    case 'lead_fmj':
      coreMult = 0.98;
      break;
    case 'lead_jhp':
      coreMult = 0.80;
      break;
    case 'soft_lead':
      coreMult = 0.72;
      break;
    case 'frangible_pellet':
      coreMult = 0.35;
      break;
  }

  // Higher speed slightly flattens effective plastic deformation on soft cores,
  // while rigid AP cores retain skipping energy across typical rifle/pistol speeds.
  const speedScale = Math.min(1.18, Math.max(0.68, 0.76 + (speedMs / 950) * 0.38));
  return Math.min(34, Math.max(1.5, mat.criticalRicochetDeg * coreMult * speedScale));
}

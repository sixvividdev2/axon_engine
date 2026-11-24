import type { PmcFactionId } from '../types';
import { OPENWORLD_LANDMARKS } from './OpenWorldTerrain';

export type FobCompoundId = 'landmark_fob_alpha' | 'landmark_fob_bravo';

export interface FobCompoundSpec {
  readonly id: FobCompoundId;
  readonly faction: PmcFactionId;
  readonly name: string;
  readonly worldX: number;
  readonly baseY: number;
  readonly worldZ: number;
  /** Compound yaw so local +Z points directly outward down the paved FOB spur road */
  readonly yaw: number;
  readonly cosY: number;
  readonly sinY: number;
  readonly halfWidthM: number;
  readonly halfDepthMinZ: number;
  readonly halfDepthMaxZ: number;
}

export interface FobGuardTowerSpec {
  readonly id: string;
  readonly cornerLabel: 'NW' | 'NE' | 'SW' | 'SE';
  readonly localX: number;
  readonly localZ: number;
  readonly worldX: number;
  readonly baseY: number;
  readonly deckY: number;
  readonly worldZ: number;
  readonly faceYaw: number;
}

export interface FobCheckpointGuardPost {
  readonly id: string;
  readonly side: 'left' | 'right';
  readonly localX: number;
  readonly localZ: number;
  readonly worldX: number;
  readonly worldZ: number;
  readonly faceYaw: number;
}

export interface FobCheckpointGateSpec {
  readonly fobId: FobCompoundId;
  readonly faction: PmcFactionId;
  readonly gateCenterX: number;
  readonly gateCenterZ: number;
  readonly pedestalX: number;
  readonly pedestalY: number;
  readonly pedestalZ: number;
  readonly pivotX: number;
  readonly pivotY: number;
  readonly pivotZ: number;
  readonly yaw: number;
  readonly armLengthM: number;
  readonly boothX: number;
  readonly boothZ: number;
  readonly guardPosts: readonly [FobCheckpointGuardPost, FobCheckpointGuardPost];
}

export interface FobRangeTargetSpec {
  readonly id: string;
  readonly fobId: FobCompoundId;
  readonly area: 'gun_range' | 'cqb_house';
  readonly laneLabel: string;
  readonly localX: number;
  readonly localY: number;
  readonly localZ: number;
  readonly worldX: number;
  readonly worldY: number;
  readonly worldZ: number;
  readonly yaw: number;
}

export interface FobPointAnchor {
  readonly localX: number;
  readonly localZ: number;
  readonly worldX: number;
  readonly worldY: number;
  readonly worldZ: number;
  readonly yaw: number;
}

function resolveFobYaw(id: FobCompoundId, worldX: number, worldZ: number): number {
  // Orient local +Z directly onto each FOB's paved spur road entrance:
  // - Alpha spur starts at (-1095, 682) -> East-Southeast of (-1120, 680)
  // - Bravo spur starts at (1135, -632) -> West-Southwest of (1160, -640)
  const roadAnchorX = id === 'landmark_fob_alpha' ? -1095 : 1135;
  const roadAnchorZ = id === 'landmark_fob_alpha' ? 682 : -632;
  const dx = roadAnchorX - worldX;
  const dz = roadAnchorZ - worldZ;
  // localToWorldXZ maps (0, +1) -> (sinY, cosY), so atan2(dx, dz) points +Z to the road
  return Math.atan2(dx, dz);
}

const COMPOUND_SPECS: Record<FobCompoundId, FobCompoundSpec> = (() => {
  const alphaLm = OPENWORLD_LANDMARKS.find((l) => l.id === 'landmark_fob_alpha')!;
  const bravoLm = OPENWORLD_LANDMARKS.find((l) => l.id === 'landmark_fob_bravo')!;
  const aYaw = resolveFobYaw('landmark_fob_alpha', alphaLm.worldX, alphaLm.worldZ);
  const bYaw = resolveFobYaw('landmark_fob_bravo', bravoLm.worldX, bravoLm.worldZ);
  return {
    landmark_fob_alpha: {
      id: 'landmark_fob_alpha',
      faction: 'pmc_alpha',
      name: alphaLm.name,
      worldX: alphaLm.worldX,
      baseY: alphaLm.targetElevationM,
      worldZ: alphaLm.worldZ,
      yaw: aYaw,
      cosY: Math.cos(aYaw),
      sinY: Math.sin(aYaw),
      halfWidthM: 44,
      halfDepthMinZ: -44,
      halfDepthMaxZ: 40,
    },
    landmark_fob_bravo: {
      id: 'landmark_fob_bravo',
      faction: 'pmc_bravo',
      name: bravoLm.name,
      worldX: bravoLm.worldX,
      baseY: bravoLm.targetElevationM,
      worldZ: bravoLm.worldZ,
      yaw: bYaw,
      cosY: Math.cos(bYaw),
      sinY: Math.sin(bYaw),
      halfWidthM: 44,
      halfDepthMinZ: -44,
      halfDepthMaxZ: 40,
    },
  };
})();

export function isFobCompoundId(id: string): id is FobCompoundId {
  return id === 'landmark_fob_alpha' || id === 'landmark_fob_bravo';
}

export function getFobCompoundSpec(id: FobCompoundId): FobCompoundSpec {
  return COMPOUND_SPECS[id];
}

export function getAllFobCompoundSpecs(): readonly FobCompoundSpec[] {
  return [COMPOUND_SPECS.landmark_fob_alpha, COMPOUND_SPECS.landmark_fob_bravo];
}

export function fobLocalToWorld(
  spec: FobCompoundSpec,
  lx: number,
  lz: number,
): { x: number; z: number } {
  return {
    x: spec.worldX + lx * spec.cosY + lz * spec.sinY,
    z: spec.worldZ - lx * spec.sinY + lz * spec.cosY,
  };
}

export function worldToFobLocal(
  spec: FobCompoundSpec,
  wx: number,
  wz: number,
): { lx: number; lz: number } {
  const dx = wx - spec.worldX;
  const dz = wz - spec.worldZ;
  return {
    lx: dx * spec.cosY - dz * spec.sinY,
    lz: dx * spec.sinY + dz * spec.cosY,
  };
}

/** Command & Quartermaster Logistics Terminal inside the HQ Command Bunker */
export function getFobTerminalAnchor(id: FobCompoundId): FobPointAnchor {
  const spec = COMPOUND_SPECS[id];
  const lx = -5.5;
  const lz = 4.0;
  const p = fobLocalToWorld(spec, lx, lz);
  return { localX: lx, localZ: lz, worldX: p.x, worldY: spec.baseY + 0.22, worldZ: p.z, yaw: spec.yaw };
}

/** Field Hospital & Surgical Aid Tent triage anchor (`fob_resupply`) */
export function getFobFieldHospitalAnchor(id: FobCompoundId): FobPointAnchor {
  const spec = COMPOUND_SPECS[id];
  const lx = 18.0;
  const lz = 9.0;
  const p = fobLocalToWorld(spec, lx, lz);
  return { localX: lx, localZ: lz, worldX: p.x, worldY: spec.baseY + 0.18, worldZ: p.z, yaw: spec.yaw };
}

/** Fortified FOB Armory Locker Row anchor (`armory_stash` gate to Player Stash/Storage) */
export function getFobArmoryStashAnchor(id: FobCompoundId): FobPointAnchor {
  const spec = COMPOUND_SPECS[id];
  const lx = 18.0;
  const lz = -7.0;
  const p = fobLocalToWorld(spec, lx, lz);
  return { localX: lx, localZ: lz, worldX: p.x, worldY: spec.baseY + 0.22, worldZ: p.z, yaw: spec.yaw };
}

/** Central Courtyard Helipad Pad anchor */
export function getFobHelipadAnchor(id: FobCompoundId): FobPointAnchor {
  const spec = COMPOUND_SPECS[id];
  const lx = 2.0;
  const lz = 21.5;
  const p = fobLocalToWorld(spec, lx, lz);
  return { localX: lx, localZ: lz, worldX: p.x, worldY: spec.baseY + 0.16, worldZ: p.z, yaw: spec.yaw };
}

/** Tier 3 Vehicle Repair & Refuel Bay anchor beside the motorpool lane */
export function getFobVehicleRepairBayAnchor(id: FobCompoundId): FobPointAnchor {
  const spec = COMPOUND_SPECS[id];
  const lx = -24.0;
  const lz = 18.5;
  const p = fobLocalToWorld(spec, lx, lz);
  return { localX: lx, localZ: lz, worldX: p.x, worldY: spec.baseY + 0.16, worldZ: p.z, yaw: spec.yaw };
}

/**
 * Unobstructed open-tarmac courtyard spawn point inside the FOB compound,
 * facing the Command Bunker, Armory, Field Hospital, and Barracks range.
 */
export function getFobCourtyardSpawnAnchor(id: FobCompoundId): FobPointAnchor {
  const spec = COMPOUND_SPECS[id];
  // Local (-18.0, -16.0) sits on wide-open staging tarmac (24.1m from center) clear of
  // Command Bunker (-5.5, +4.0), Billeting Tent (-29.0, +5.5), and CQB Shoot-House (0..+16, -36..-22).
  // In world space this places Alpha SW looking NE and Bravo NE looking SW across the entire FOB compound.
  const lx = -18.0;
  const lz = -16.0;
  const p = fobLocalToWorld(spec, lx, lz);
  // Look directly across the compound center toward Command Bunker, Armory, Hospital & horizon
  const dx = spec.worldX - p.x;
  const dz = spec.worldZ - p.z;
  const yaw = Math.atan2(-dx, -dz);
  return { localX: lx, localZ: lz, worldX: p.x, worldY: spec.baseY + 0.08, worldZ: p.z, yaw };
}

/** Fast check whether world XZ lies inside any fortified FOB compound footprint (plus optional margin). */
export function isInsideFobCompound(wx: number, wz: number, padM = 0): boolean {
  const specs = [COMPOUND_SPECS.landmark_fob_alpha, COMPOUND_SPECS.landmark_fob_bravo];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const dx = wx - spec.worldX;
    const dz = wz - spec.worldZ;
    // Quick radial reject before rotating into local compound coordinates
    const maxR = 64 + padM;
    if (dx * dx + dz * dz > maxR * maxR) continue;
    const lx = dx * spec.cosY - dz * spec.sinY;
    const lz = dx * spec.sinY + dz * spec.cosY;
    if (
      lx >= -spec.halfWidthM - padM &&
      lx <= spec.halfWidthM + padM &&
      lz >= spec.halfDepthMinZ - padM &&
      lz <= spec.halfDepthMaxZ + 10 + padM
    ) {
      return true;
    }
  }
  return false;
}

export const FOB_GUARD_TOWER_DECK_HEIGHT_M = 5.6;

/** 4 Elevated Corner Guard Towers around the perimeter walls */
export function getFobGuardTowerSpecs(id: FobCompoundId): readonly FobGuardTowerSpec[] {
  const spec = COMPOUND_SPECS[id];
  const corners: Array<{ corner: 'NW' | 'NE' | 'SW' | 'SE'; lx: number; lz: number }> = [
    { corner: 'NW', lx: -39.8, lz: -39.8 },
    { corner: 'NE', lx: 39.8, lz: -39.8 },
    { corner: 'SW', lx: -39.8, lz: 35.8 },
    { corner: 'SE', lx: 39.8, lz: 35.8 },
  ];
  return corners.map((c) => {
    const p = fobLocalToWorld(spec, c.lx, c.lz);
    // Face diagonally outward from compound center
    const dx = p.x - spec.worldX;
    const dz = p.z - spec.worldZ;
    const faceYaw = Math.atan2(-dx, -dz);
    return {
      id: `${id}_tower_${c.corner}`,
      cornerLabel: c.corner,
      localX: c.lx,
      localZ: c.lz,
      worldX: p.x,
      baseY: spec.baseY,
      deckY: spec.baseY + FOB_GUARD_TOWER_DECK_HEIGHT_M,
      worldZ: p.z,
      faceYaw,
    };
  });
}

/** Military-Base Style Checkpoint Entry + Hinged AI Boom Gate & 2 On-Foot Guards */
export function getFobCheckpointGateSpec(id: FobCompoundId): FobCheckpointGateSpec {
  const spec = COMPOUND_SPECS[id];
  const gateLz = 40.0;
  const gateCenter = fobLocalToWorld(spec, 0, gateLz);
  const pedestal = fobLocalToWorld(spec, 3.85, gateLz);
  const booth = fobLocalToWorld(spec, 6.8, gateLz);
  const leftGuard = fobLocalToWorld(spec, -4.6, gateLz + 3.2);
  const rightGuard = fobLocalToWorld(spec, 4.4, gateLz - 3.0);
  // Look outward along road (+Z local)
  const outwardYaw = spec.yaw + Math.PI;
  const inwardYaw = spec.yaw;

  return {
    fobId: id,
    faction: spec.faction,
    gateCenterX: gateCenter.x,
    gateCenterZ: gateCenter.z,
    pedestalX: pedestal.x,
    pedestalY: spec.baseY,
    pedestalZ: pedestal.z,
    pivotX: pedestal.x,
    pivotY: spec.baseY + 1.05,
    pivotZ: pedestal.z,
    yaw: spec.yaw,
    armLengthM: 7.4,
    boothX: booth.x,
    boothZ: booth.z,
    guardPosts: [
      {
        id: `${id}_gate_guard_left`,
        side: 'left',
        localX: -4.6,
        localZ: gateLz + 3.2,
        worldX: leftGuard.x,
        worldZ: leftGuard.z,
        faceYaw: outwardYaw,
      },
      {
        id: `${id}_gate_guard_right`,
        side: 'right',
        localX: 4.4,
        localZ: gateLz - 3.0,
        worldX: rightGuard.x,
        worldZ: rightGuard.z,
        faceYaw: inwardYaw + Math.PI * 0.88,
      },
    ],
  };
}

/**
 * Reactive steel silhouette targets placed inside each FOB's:
 * 1) Barracks Live-Fire Gun Range (6 lane targets at 10m & 18m)
 * 2) Barracks Walled CQB Shoot-House (4 indoor breaching targets)
 */
export function getFobRangeTargetSpecs(id: FobCompoundId): readonly FobRangeTargetSpec[] {
  const spec = COMPOUND_SPECS[id];
  const defs: Array<{
    key: string;
    area: 'gun_range' | 'cqb_house';
    laneLabel: string;
    lx: number;
    ly: number;
    lz: number;
    dyaw: number;
  }> = [
    // Live-fire gun range: shooters stand near lz = -19 facing north (-Z local) toward berm at lz = -37
    { key: 'lane1_near', area: 'gun_range', laneLabel: 'Lane 1 · 10m', lx: 22.5, ly: 0.12, lz: -28.0, dyaw: 0 },
    { key: 'lane1_far', area: 'gun_range', laneLabel: 'Lane 1 · 18m', lx: 22.5, ly: 0.12, lz: -34.5, dyaw: 0 },
    { key: 'lane2_near', area: 'gun_range', laneLabel: 'Lane 2 · 10m', lx: 28.0, ly: 0.12, lz: -28.0, dyaw: 0 },
    { key: 'lane2_far', area: 'gun_range', laneLabel: 'Lane 2 · 18m', lx: 28.0, ly: 0.12, lz: -34.5, dyaw: 0 },
    { key: 'lane3_near', area: 'gun_range', laneLabel: 'Lane 3 · 10m', lx: 33.5, ly: 0.12, lz: -28.0, dyaw: 0 },
    { key: 'lane3_far', area: 'gun_range', laneLabel: 'Lane 3 · 18m', lx: 33.5, ly: 0.12, lz: -34.5, dyaw: 0 },
    // Walled CQB Shoot-House targets (entrance at lx = 0, lz = -29; interior lx in [0..16], lz in [-36..-22])
    { key: 'cqb_entry', area: 'cqb_house', laneLabel: 'CQB Entry Hall', lx: 5.8, ly: 0.22, lz: -25.2, dyaw: -Math.PI * 0.5 },
    { key: 'cqb_breach_nw', area: 'cqb_house', laneLabel: 'CQB Room North', lx: 4.5, ly: 0.22, lz: -33.2, dyaw: 0 },
    { key: 'cqb_breach_se', area: 'cqb_house', laneLabel: 'CQB Room East', lx: 13.6, ly: 0.22, lz: -25.4, dyaw: -Math.PI * 0.5 },
    { key: 'cqb_breach_ne', area: 'cqb_house', laneLabel: 'CQB Killhouse Corner', lx: 13.8, ly: 0.22, lz: -33.6, dyaw: -Math.PI * 0.25 },
  ];

  return defs.map((d) => {
    const p = fobLocalToWorld(spec, d.lx, d.lz);
    return {
      id: `${id}_${d.key}`,
      fobId: id,
      area: d.area,
      laneLabel: d.laneLabel,
      localX: d.lx,
      localY: d.ly,
      localZ: d.lz,
      worldX: p.x,
      worldY: spec.baseY + d.ly,
      worldZ: p.z,
      yaw: spec.yaw + d.dyaw,
    };
  });
}

/**
 * Checks if a chunk AABB `[minX, maxX] x [minZ, maxZ]` overlaps a FOB compound footprint.
 */
export function getFobCompoundsOverlappingRect(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): FobCompoundSpec[] {
  const out: FobCompoundSpec[] = [];
  const radiusPad = 62;
  for (const spec of getAllFobCompoundSpecs()) {
    if (
      spec.worldX + radiusPad >= minX &&
      spec.worldX - radiusPad <= maxX &&
      spec.worldZ + radiusPad >= minZ &&
      spec.worldZ - radiusPad <= maxZ
    ) {
      out.push(spec);
    }
  }
  return out;
}

import * as THREE from 'three';
import {
  BodycamPhysicsWorld,
  BodycamSurfaceMaterial,
  DynamicPropSpawnSpec,
} from '../bodycam-sdk';
import { buildMergedInteriorDressing, InteriorDressingTheme } from './InteriorDressingBuilder';
import { PropFactoryContext } from './MapPropFactory';
import {
  createCabinWoodTexture,
  createCorrugatedMetalTexture,
  createIndustrialSlateConcreteTexture,
  createSovietConcreteTexture,
} from './MapTextures';

export type CoverBuildingPreset =
  | 'rural_farmhouse'
  | 'industrial_garage'
  | 'soviet_annex'
  | 'timber_cabin';

export interface CoverBuildingSpec {
  id: string;
  preset: CoverBuildingPreset;
  /** World-space center X */
  x: number;
  /** World-space center Z */
  z: number;
  /** Floor height Y (typically terrainHeightAt(x, z) + 0.08) */
  y: number;
  /** Rotation in multiples of 90 degrees (0, 1, 2, 3 -> 0, 90, 180, 270 deg) for exact AABB alignment */
  rotQuarterTurns?: 0 | 1 | 2 | 3;
  /** Footprint width along local X (default 10.5m) */
  width?: number;
  /** Footprint depth along local Z (default 8.4m) */
  depth?: number;
  /** Interior ceiling height (default 3.6m) */
  height?: number;
  /** Optional shared materials override to keep draw calls & VRAM minimal */
  materials?: CoverBuildingMaterialPack;
}

export interface CoverBuildingMaterialPack {
  wallExt: THREE.Material;
  wallInt: THREE.Material;
  floor: THREE.Material;
  roof: THREE.Material;
  trim: THREE.Material;
  crate: THREE.Material;
  foundation: THREE.Material;
  wallSurface: BodycamSurfaceMaterial;
  floorSurface: BodycamSurfaceMaterial;
}

export interface BuiltCoverBuilding {
  id: string;
  group: THREE.Group;
  /** World-space interior center node for AI navigation */
  interiorPos: [number, number, number];
  /** World-space exterior entry points just outside each doorway for AI NavGraph stitching */
  entryPoints: Array<[number, number, number]>;
  /** Surface-grounded dynamic physics prop spawns emitted inside this building */
  propSpawns: DynamicPropSpawnSpec[];
}

/**
 * Creates a reusable per-preset PBR material pack tracked by the map's dispose lists.
 * Sharing packs across multiple buildings on a map minimizes WebGL shader & texture switches.
 */
export function createCoverBuildingMaterialPack(
  ctx: PropFactoryContext,
  preset: CoverBuildingPreset,
  trackTex?: <T extends THREE.Texture>(t: T) => T,
): CoverBuildingMaterialPack {
  const aniso = ctx.maxAniso ?? 4;
  const regTex = <T extends THREE.Texture>(t: T): T => (trackTex ? trackTex(t) : t);
  const { trackMat } = ctx;

  const matFoundation = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x4b4f52, roughness: 0.94, metalness: 0.03 }),
  );
  const matTrimDark = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x2e3133, roughness: 0.72, metalness: 0.25 }),
  );
  const matCrateWood = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x6f583c, roughness: 0.88, metalness: 0.04 }),
  );

  if (preset === 'timber_cabin') {
    const wallTex = regTex(createCabinWoodTexture(aniso, 2, 1, '#5d4531', 7101));
    const floorTex = regTex(createCabinWoodTexture(aniso, 3, 2, '#463424', 7102));
    const roofTex = regTex(createCorrugatedMetalTexture(aniso, '#3c4542', 7103));
    return {
      wallExt: trackMat(new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.9, metalness: 0.03 })),
      wallInt: trackMat(new THREE.MeshStandardMaterial({ map: wallTex, color: 0xd4c6b2, roughness: 0.92, metalness: 0.02 })),
      floor: trackMat(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.88, metalness: 0.03 })),
      roof: trackMat(new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.74, metalness: 0.35 })),
      trim: matTrimDark,
      crate: matCrateWood,
      foundation: matFoundation,
      wallSurface: 'wood',
      floorSurface: 'wood',
    };
  }

  if (preset === 'industrial_garage') {
    const wallTex = regTex(createCorrugatedMetalTexture(aniso, '#4b5558', 7201));
    const concTex = regTex(createIndustrialSlateConcreteTexture(aniso, 3, 2, '#545b61', 7202));
    const roofTex = regTex(createCorrugatedMetalTexture(aniso, '#3b4246', 7203));
    return {
      wallExt: trackMat(new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.74, metalness: 0.42 })),
      wallInt: trackMat(new THREE.MeshStandardMaterial({ map: concTex, roughness: 0.9, metalness: 0.06 })),
      floor: trackMat(new THREE.MeshStandardMaterial({ map: concTex, roughness: 0.92, metalness: 0.04 })),
      roof: trackMat(new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.7, metalness: 0.45 })),
      trim: matTrimDark,
      crate: trackMat(new THREE.MeshStandardMaterial({ color: 0x455148, roughness: 0.74, metalness: 0.32 })),
      foundation: matFoundation,
      wallSurface: 'metal',
      floorSurface: 'concrete',
    };
  }

  if (preset === 'soviet_annex') {
    const extTex = regTex(createSovietConcreteTexture(aniso, 3, 2, '#7d7f78', 7301));
    const intTex = regTex(createSovietConcreteTexture(aniso, 2, 2, '#96988e', 7302));
    const floorTex = regTex(createIndustrialSlateConcreteTexture(aniso, 3, 2, '#5a5f63', 7303));
    return {
      wallExt: trackMat(new THREE.MeshStandardMaterial({ map: extTex, roughness: 0.92, metalness: 0.03 })),
      wallInt: trackMat(new THREE.MeshStandardMaterial({ map: intTex, roughness: 0.94, metalness: 0.02 })),
      floor: trackMat(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.9, metalness: 0.04 })),
      roof: trackMat(new THREE.MeshStandardMaterial({ color: 0x414548, roughness: 0.92, metalness: 0.05 })),
      trim: matTrimDark,
      crate: matCrateWood,
      foundation: matFoundation,
      wallSurface: 'concrete',
      floorSurface: 'concrete',
    };
  }

  // 'rural_farmhouse'
  const wallTex = regTex(createSovietConcreteTexture(aniso, 3, 2, '#8b8373', 7401));
  const floorTex = regTex(createCabinWoodTexture(aniso, 3, 2, '#524030', 7402));
  const roofTex = regTex(createCorrugatedMetalTexture(aniso, '#544139', 7403));
  return {
    wallExt: trackMat(new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.92, metalness: 0.02 })),
    wallInt: trackMat(new THREE.MeshStandardMaterial({ map: wallTex, color: 0xd8d0be, roughness: 0.93, metalness: 0.02 })),
    floor: trackMat(new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.89, metalness: 0.03 })),
    roof: trackMat(new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.78, metalness: 0.28 })),
    trim: matTrimDark,
    crate: matCrateWood,
    foundation: matFoundation,
    wallSurface: 'concrete',
    floorSurface: 'wood',
  };
}

/**
 * Builds a purely neutral enterable cover building with full multi-room interior,
 * opposing doorways (no one-way traps), waist-high tactical firing windows, interior
 * cover partitions/crates, sloped-terrain foundation plinth, and fast analytical AABB
 * colliders (`blocksRaycast: true`, `analyticalRaycastCovered: true`).
 *
 * Strictly non-objective: creates zero capture rings, banners, or HUD markers.
 */
export function buildEnterableCoverBuilding(
  ctx: PropFactoryContext,
  spec: CoverBuildingSpec,
  trackTex?: <T extends THREE.Texture>(t: T) => T,
): BuiltCoverBuilding {
  const { sceneGroup, physics, raycastMeshes, isSoftwareGl, trackGeo } = ctx;
  const mats = spec.materials ?? createCoverBuildingMaterialPack(ctx, spec.preset, trackTex);

  const W = spec.width ?? (spec.preset === 'industrial_garage' ? 12.0 : 10.6);
  const D = spec.depth ?? (spec.preset === 'industrial_garage' ? 9.2 : 8.4);
  const H = spec.height ?? (spec.preset === 'industrial_garage' ? 4.2 : 3.5);
  const T = 0.28; // Exterior wall thickness
  const turns = spec.rotQuarterTurns ?? 0;

  const group = new THREE.Group();
  group.name = `cover_building_${spec.id}`;
  sceneGroup.add(group);

  // Quarter-turn local -> world transform helper so all physics boxes are exact world-axis AABBs
  const toWorldXZ = (lx: number, lz: number): [number, number] => {
    if (turns === 1) return [spec.x + lz, spec.z - lx];
    if (turns === 2) return [spec.x - lx, spec.z - lz];
    if (turns === 3) return [spec.x - lz, spec.z + lx];
    return [spec.x + lx, spec.z + lz];
  };

  const toWorldDims = (bw: number, bd: number): [number, number] =>
    turns === 1 || turns === 3 ? [bd, bw] : [bw, bd];

  const addStructBox = (
    lx: number,
    lyBottom: number,
    lz: number,
    bw: number,
    bh: number,
    bd: number,
    mat: THREE.Material,
    surface: BodycamSurfaceMaterial,
    blocksMovement = true,
    blocksRaycast = true,
    castShadow = true,
  ): THREE.Mesh => {
    const [wx, wz] = toWorldXZ(lx, lz);
    const [ww, wd] = toWorldDims(bw, bd);
    const wy = spec.y + lyBottom + bh * 0.5;

    const mesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(ww, bh, wd)), mat);
    mesh.position.set(wx, wy, wz);
    mesh.castShadow = !isSoftwareGl && castShadow;
    mesh.receiveShadow = !isSoftwareGl;
    mesh.userData.surfaceMaterial = surface;
    if (blocksRaycast) {
      mesh.userData.analyticalRaycastCovered = true;
    }
    group.add(mesh);
    raycastMeshes.push(mesh);

    if (blocksMovement || blocksRaycast) {
      physics.addBox({
        minX: wx - ww * 0.5,
        maxX: wx + ww * 0.5,
        minY: spec.y + lyBottom,
        maxY: spec.y + lyBottom + bh,
        minZ: wz - wd * 0.5,
        maxZ: wz + wd * 0.5,
        surface,
        blocksMovement,
        blocksRaycast,
        meshRef: mesh,
      });
    }
    return mesh;
  };

  // 1. Foundation plinth extending 1.6m below floor so building never floats on alpine slopes
  addStructBox(0, -1.6, 0, W + 0.3, 1.62, D + 0.3, mats.foundation, 'concrete', false, true, false);

  // 2. Interior solid floor slab (thickness 0.14m, top surface at spec.y + 0.14)
  const floorTop = 0.14;
  addStructBox(0, 0, 0, W, floorTop, D, mats.floor, mats.floorSurface, true, true, false);

  // Helper to build a wall segment with either a doorway opening OR a waist-high tactical firing window
  const doorW = spec.preset === 'industrial_garage' ? 3.0 : 1.75;
  const doorH = spec.preset === 'industrial_garage' ? 3.0 : 2.35;
  const winW = 2.0;
  const winSill = 1.05; // Waist-high firing ledge
  const winTop = 2.25;

  const buildNorthSouthWall = (
    lz: number,
    opening: 'door' | 'window',
    openingOffsetX = 0,
  ) => {
    const opW = opening === 'door' ? doorW : winW;
    const leftEnd = -W * 0.5;
    const rightEnd = W * 0.5;
    const opMin = openingOffsetX - opW * 0.5;
    const opMax = openingOffsetX + opW * 0.5;

    const leftSpan = Math.max(0.4, opMin - leftEnd);
    const rightSpan = Math.max(0.4, rightEnd - opMax);

    // Left pier
    addStructBox(leftEnd + leftSpan * 0.5, floorTop, lz, leftSpan, H, T, mats.wallExt, mats.wallSurface);
    // Right pier
    addStructBox(opMax + rightSpan * 0.5, floorTop, lz, rightSpan, H, T, mats.wallExt, mats.wallSurface);

    if (opening === 'door') {
      // Lintel above doorway
      const lintelH = Math.max(0.25, H - doorH);
      addStructBox(openingOffsetX, floorTop + doorH, lz, opW, lintelH, T, mats.wallExt, mats.wallSurface);
      // Dark doorway trim frame
      addStructBox(openingOffsetX, floorTop + doorH - 0.06, lz, opW + 0.12, 0.1, T + 0.06, mats.trim, 'metal', false, false, false);
    } else {
      // Waist-high sill wall below firing window
      addStructBox(openingOffsetX, floorTop, lz, opW, winSill, T, mats.wallExt, mats.wallSurface);
      // Header above firing window
      const headH = Math.max(0.25, H - winTop);
      addStructBox(openingOffsetX, floorTop + winTop, lz, opW, headH, T, mats.wallExt, mats.wallSurface);
      // Window sill trim
      addStructBox(openingOffsetX, floorTop + winSill - 0.04, lz, opW + 0.14, 0.08, T + 0.08, mats.trim, 'concrete', false, false, false);
    }
  };

  const buildEastWestWall = (
    lx: number,
    opening: 'door' | 'window',
    openingOffsetZ = 0,
  ) => {
    const opW = opening === 'door' ? 1.65 : winW;
    const nearEnd = -D * 0.5 + T * 0.5;
    const farEnd = D * 0.5 - T * 0.5;
    const opMin = openingOffsetZ - opW * 0.5;
    const opMax = openingOffsetZ + opW * 0.5;

    const nearSpan = Math.max(0.4, opMin - nearEnd);
    const farSpan = Math.max(0.4, farEnd - opMax);

    addStructBox(lx, floorTop, nearEnd + nearSpan * 0.5, T, H, nearSpan, mats.wallExt, mats.wallSurface);
    addStructBox(lx, floorTop, opMax + farSpan * 0.5, T, H, farSpan, mats.wallExt, mats.wallSurface);

    if (opening === 'door') {
      const lintelH = Math.max(0.25, H - 2.35);
      addStructBox(lx, floorTop + 2.35, openingOffsetZ, T, lintelH, opW, mats.wallExt, mats.wallSurface);
      addStructBox(lx, floorTop + 2.3, openingOffsetZ, T + 0.06, 0.1, opW + 0.12, mats.trim, 'metal', false, false, false);
    } else {
      addStructBox(lx, floorTop, openingOffsetZ, T, winSill, opW, mats.wallExt, mats.wallSurface);
      const headH = Math.max(0.25, H - winTop);
      addStructBox(lx, floorTop + winTop, openingOffsetZ, T, headH, opW, mats.wallExt, mats.wallSurface);
      addStructBox(lx, floorTop + winSill - 0.04, openingOffsetZ, T + 0.08, 0.08, opW + 0.14, mats.trim, 'concrete', false, false, false);
    }
  };

  // 3. Four exterior walls: 2 opposing doorways (North & South) + 2 tactical firing windows (East & West)
  // Plus a side door on garages for triple-egress flanking
  buildNorthSouthWall(-D * 0.5 + T * 0.5, 'door', -W * 0.16);
  buildNorthSouthWall(D * 0.5 - T * 0.5, 'door', W * 0.16);
  buildEastWestWall(-W * 0.5 + T * 0.5, 'window', 0);
  buildEastWestWall(W * 0.5 - T * 0.5, spec.preset === 'industrial_garage' ? 'door' : 'window', 0);

  // 4. Exterior entrance step ramps at doorways so walking in from sloped terrain is buttery smooth
  addStructBox(-W * 0.16, -0.04, -D * 0.5 - 0.55, doorW + 0.5, 0.16, 1.1, mats.foundation, 'concrete', true, true, false);
  addStructBox(W * 0.16, -0.04, D * 0.5 + 0.55, doorW + 0.5, 0.16, 1.1, mats.foundation, 'concrete', true, true, false);

  // 5. Roof slab + architectural overhang / parapet
  if (spec.preset === 'soviet_annex') {
    // Flat concrete roof with protective parapet lip
    addStructBox(0, floorTop + H, 0, W + 0.35, 0.24, D + 0.35, mats.roof, 'concrete');
    addStructBox(0, floorTop + H + 0.24, -D * 0.5, W + 0.35, 0.42, 0.22, mats.wallExt, 'concrete', false, true, false);
    addStructBox(0, floorTop + H + 0.24, D * 0.5, W + 0.35, 0.42, 0.22, mats.wallExt, 'concrete', false, true, false);
  } else {
    // Stepped gable / pitched corrugated roof profile (keeps exact analytical box colliders + crisp silhouette)
    addStructBox(0, floorTop + H, 0, W + 0.7, 0.22, D + 0.7, mats.roof, 'metal');
    addStructBox(0, floorTop + H + 0.22, 0, W + 0.35, 0.44, D * 0.68, mats.roof, 'metal', false, true, true);
    addStructBox(0, floorTop + H + 0.66, 0, W + 0.1, 0.36, D * 0.34, mats.roof, 'metal', false, true, false);
  }

  // 6. Interior room divider partition wall (creates 2-room tactical interior with wide central passage)
  const divSpan = Math.max(2.2, D * 0.42);
  addStructBox(0.15, floorTop, -D * 0.5 + T + divSpan * 0.5, 0.2, H - 0.05, divSpan, mats.wallInt, mats.wallSurface);

  // 7. Interior waist-high cover props (supply crates / workbenches / concrete desk)
  addStructBox(-W * 0.26, floorTop, D * 0.22, 1.5, 1.05, 0.95, mats.crate, 'wood');
  addStructBox(W * 0.28, floorTop, -D * 0.22, 1.25, 1.15, 1.25, mats.crate, 'wood');
  addStructBox(W * 0.25, floorTop + 1.15, -D * 0.22, 0.8, 0.65, 0.8, mats.crate, 'wood');

  // 8. Merged architectural interior dressing (desks, shelving, ceiling joists/conduits,
  //    radiators, breaker panel, fire extinguisher, corkboard) + grounded physics prop spawns
  const dressingTheme: InteriorDressingTheme =
    spec.preset === 'industrial_garage'
      ? 'industrial_garage'
      : spec.preset === 'timber_cabin'
        ? 'timber_cabin'
        : spec.preset === 'soviet_annex'
          ? 'soviet_office'
          : 'rural_farmhouse';
  let seedHash = 313;
  for (let i = 0; i < spec.id.length; i++) {
    seedHash = ((seedHash * 31) ^ spec.id.charCodeAt(i)) | 0;
  }
  const dressing = buildMergedInteriorDressing(ctx, {
    theme: dressingTheme,
    cx: spec.x,
    floorY: spec.y + floorTop,
    cz: spec.z,
    width: W,
    depth: D,
    height: H,
    rotQuarterTurns: turns,
    seed: Math.abs(seedHash) + 17,
  });
  group.add(dressing.group);

  // Also add bottles/cans resting right on top of the interior cover crate!
  const [crateWx, crateWz] = toWorldXZ(-W * 0.26, D * 0.22);
  dressing.propSpawns.push(
    { kind: 'glass_bottle_green', x: crateWx - 0.22, y: spec.y + floorTop + 1.07, z: crateWz + 0.1 },
    { kind: 'soda_can', x: crateWx + 0.18, y: spec.y + floorTop + 1.07, z: crateWz - 0.12 },
  );
  if (ctx.propSpawns) {
    ctx.propSpawns.push(...dressing.propSpawns);
  }
  group.userData.propSpawns = dressing.propSpawns;

  // Register interior acoustic zone so weapon/footstep reverb shifts realistically indoors
  const [iwx, iwz] = toWorldXZ(0, 0);
  const [iww, iwd] = toWorldDims(W - 0.6, D - 0.6);
  physics.addInteriorZone({
    minX: iwx - iww * 0.5,
    maxX: iwx + iww * 0.5,
    minY: spec.y,
    maxY: spec.y + floorTop + H,
    minZ: iwz - iwd * 0.5,
    maxZ: iwz + iwd * 0.5,
    material: mats.wallSurface === 'wood' ? 'wood' : 'concrete',
  });

  // Compute world-space AI navigation waypoints (interior center + outside each doorway)
  const [inX, inZ] = toWorldXZ(0, D * 0.14);
  const [doorAX, doorAZ] = toWorldXZ(-W * 0.16, -D * 0.5 - 2.0);
  const [doorBX, doorBZ] = toWorldXZ(W * 0.16, D * 0.5 + 2.0);

  const entryPoints: Array<[number, number, number]> = [
    [doorAX, spec.y + 0.08, doorAZ],
    [doorBX, spec.y + 0.08, doorBZ],
  ];
  if (spec.preset === 'industrial_garage') {
    const [doorCX, doorCZ] = toWorldXZ(W * 0.5 + 2.0, 0);
    entryPoints.push([doorCX, spec.y + 0.08, doorCZ]);
  }

  return {
    id: spec.id,
    group,
    interiorPos: [inX, spec.y + floorTop + 0.04, inZ],
    entryPoints,
    propSpawns: dressing.propSpawns,
  };
}

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { DynamicPropSpawnSpec } from '../bodycam-sdk';
import type { PropFactoryContext } from './MapPropFactory';

export type InteriorDressingTheme =
  | 'soviet_office'
  | 'industrial_garage'
  | 'timber_cabin'
  | 'rural_farmhouse'
  | 'bunker_ops';

export interface InteriorDressingRoomSpec {
  theme: InteriorDressingTheme;
  /** World-space center X */
  cx: number;
  /** World-space floor top Y */
  floorY: number;
  /** World-space center Z */
  cz: number;
  /** Room width along local X */
  width: number;
  /** Room depth along local Z */
  depth: number;
  /** Ceiling height above floorY */
  height: number;
  /** Rotation in quarter turns (0..3) matching CoverBuildingSpec */
  rotQuarterTurns?: 0 | 1 | 2 | 3;
  /** Deterministic seed for subtle variation */
  seed: number;
}

export interface InteriorDressingResult {
  group: THREE.Group;
  propSpawns: DynamicPropSpawnSpec[];
}

interface BatchBucket {
  geos: THREE.BufferGeometry[];
  mat: THREE.Material;
  surface: 'metal' | 'wood' | 'concrete';
}

const _tmpMat4 = new THREE.Matrix4();
const _tmpQuat = new THREE.Quaternion();
const _tmpEuler = new THREE.Euler();
const _tmpPos = new THREE.Vector3();
const _tmpScale = new THREE.Vector3(1, 1, 1);

function pushBox(
  bucket: BatchBucket,
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  rotY = 0,
): void {
  const g = new THREE.BoxGeometry(w, h, d);
  _tmpPos.set(x, y, z);
  _tmpEuler.set(0, rotY, 0);
  _tmpQuat.setFromEuler(_tmpEuler);
  _tmpMat4.compose(_tmpPos, _tmpQuat, _tmpScale);
  g.applyMatrix4(_tmpMat4);
  bucket.geos.push(g);
}

function pushCylinder(
  bucket: BatchBucket,
  rTop: number,
  rBot: number,
  h: number,
  segs: number,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
): void {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, segs);
  _tmpPos.set(x, y, z);
  _tmpEuler.set(rx, ry, rz);
  _tmpQuat.setFromEuler(_tmpEuler);
  _tmpMat4.compose(_tmpPos, _tmpQuat, _tmpScale);
  g.applyMatrix4(_tmpMat4);
  bucket.geos.push(g);
}

/**
 * Builds rich, low-draw-call merged static interior architecture & furniture dressing
 * (baseboards, ceiling beams, electrical conduits, shelving racks, steel desks, workbenches,
 * cast-iron radiators, breaker boxes, fire extinguishers, and wall boards) while keeping
 * doorways & central walkways 100% unobstructed and emitting surface-grounded physics prop spawns.
 */
export function buildMergedInteriorDressing(
  ctx: PropFactoryContext,
  spec: InteriorDressingRoomSpec,
): InteriorDressingResult {
  const { isSoftwareGl, trackGeo, trackMat } = ctx;
  const turns = spec.rotQuarterTurns ?? 0;
  const W = spec.width;
  const D = spec.depth;
  const H = spec.height;
  const halfW = W * 0.5;
  const halfD = D * 0.5;
  const inset = 0.24; // Wall thickness safety inset

  const group = new THREE.Group();
  group.name = `interior_dressing_${spec.theme}_${spec.seed}`;
  group.position.set(spec.cx, spec.floorY, spec.cz);
  group.rotation.y = turns * (Math.PI * 0.5);

  const toWorldXZ = (lx: number, lz: number): [number, number] => {
    if (turns === 1) return [spec.cx + lz, spec.cz - lx];
    if (turns === 2) return [spec.cx - lx, spec.cz - lz];
    if (turns === 3) return [spec.cx - lz, spec.cz + lx];
    return [spec.cx + lx, spec.cz + lz];
  };

  const matSteelDark = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x32383e, roughness: 0.46, metalness: 0.72 }),
  );
  const matSteelPainted = trackMat(
    new THREE.MeshStandardMaterial({
      color: spec.theme === 'soviet_office' ? 0x4b5c58 : 0x454f46,
      roughness: 0.54,
      metalness: 0.45,
    }),
  );
  const matWood = trackMat(
    new THREE.MeshStandardMaterial({
      color: spec.theme === 'timber_cabin' ? 0x624630 : 0x735940,
      roughness: 0.86,
      metalness: 0.04,
    }),
  );
  const matAccentRed = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x8f2822, roughness: 0.42, metalness: 0.34 }),
  );
  const matTrim = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x2a2d30, roughness: 0.78, metalness: 0.18 }),
  );
  const matBoard = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x8a795d, roughness: 0.92, metalness: 0.02 }),
  );

  const steelDark: BatchBucket = { geos: [], mat: matSteelDark, surface: 'metal' };
  const steelPainted: BatchBucket = { geos: [], mat: matSteelPainted, surface: 'metal' };
  const wood: BatchBucket = { geos: [], mat: matWood, surface: 'wood' };
  const accentRed: BatchBucket = { geos: [], mat: matAccentRed, surface: 'metal' };
  const trim: BatchBucket = { geos: [], mat: matTrim, surface: 'concrete' };
  const board: BatchBucket = { geos: [], mat: matBoard, surface: 'wood' };

  const propSpawns: DynamicPropSpawnSpec[] = [];
  const addProp = (
    kind: DynamicPropSpawnSpec['kind'],
    lx: number,
    ly: number,
    lz: number,
    yaw = 0,
    roll = 0,
  ) => {
    const [wx, wz] = toWorldXZ(lx, lz);
    propSpawns.push({
      kind,
      x: wx,
      y: spec.floorY + ly,
      z: wz,
      yaw: yaw + turns * Math.PI * 0.5,
      roll,
    });
  };

  // 1. Ceiling structural steel joists + overhead electrical conduit run + fluorescent housing
  const beamCount = Math.max(2, Math.floor(D / 3.2));
  for (let i = 0; i < beamCount; i++) {
    const bz = -halfD + 1.2 + (i / Math.max(1, beamCount - 1)) * (D - 2.4);
    pushBox(steelDark, W - 0.56, 0.14, 0.12, 0, H - 0.09, bz);
  }
  // Dual overhead steel utility pipes along ceiling
  pushCylinder(steelDark, 0.032, 0.032, D - 0.8, 6, -halfW + 0.65, H - 0.22, 0, Math.PI * 0.5);
  pushCylinder(steelDark, 0.024, 0.024, D - 0.8, 6, -halfW + 0.82, H - 0.22, 0, Math.PI * 0.5);
  // Twin industrial fluorescent fixture housings on ceiling
  for (const fx of [-W * 0.2, W * 0.22]) {
    pushBox(steelPainted, 1.35, 0.07, 0.22, fx, H - 0.12, 0);
  }

  // 2. Interior baseboards on corners (clear of doorways) + electrical breaker panel + fire extinguisher
  pushBox(trim, 0.06, 0.14, 1.6, -halfW + inset + 0.03, 0.07, -halfD + 1.2);
  pushBox(trim, 0.06, 0.14, 1.6, -halfW + inset + 0.03, 0.07, halfD - 1.2);
  pushBox(trim, 0.06, 0.14, 1.6, halfW - inset - 0.03, 0.07, -halfD + 1.2);
  pushBox(trim, 0.06, 0.14, 1.6, halfW - inset - 0.03, 0.07, halfD - 1.2);

  // Wall electrical breaker box + vertical conduit on NW interior corner wall
  const panelX = -halfW + inset + 0.11;
  const panelZ = -halfD + 1.1;
  pushBox(steelPainted, 0.16, 0.62, 0.44, panelX, 1.52, panelZ);
  pushCylinder(steelDark, 0.018, 0.018, H - 1.8, 6, panelX - 0.02, 1.82 + (H - 1.8) * 0.5, panelZ);
  // Wall-mounted red fire extinguisher beside breaker panel
  pushCylinder(accentRed, 0.085, 0.085, 0.52, 8, panelX + 0.02, 0.92, panelZ + 0.58);
  pushCylinder(steelDark, 0.03, 0.03, 0.1, 6, panelX + 0.02, 1.22, panelZ + 0.58);

  // 3. Cast-iron radiator under West window sill (never blocks windows or doors)
  const radX = -halfW + inset + 0.14;
  for (let r = 0; r < 6; r++) {
    pushBox(steelDark, 0.12, 0.56, 0.07, radX, 0.36, -0.45 + r * 0.18);
  }
  pushCylinder(steelDark, 0.02, 0.02, 1.1, 6, radX, 0.6, 0, Math.PI * 0.5);

  // 4. Theme-specific room furniture hugging perimeter walls (leaving center & doors clear)
  // Corner A: North-East corner shelving unit (4-tier industrial rack)
  const rackX = halfW - inset - 0.34;
  const rackZ = -halfD + inset + 1.15;
  const rackW = 0.52;
  const rackD = 1.65;
  const rackH = 1.95;
  for (const px of [-rackW * 0.46, rackW * 0.46]) {
    for (const pz of [-rackD * 0.46, rackD * 0.46]) {
      pushBox(steelDark, 0.045, rackH, 0.045, rackX + px, rackH * 0.5, rackZ + pz);
    }
  }
  const shelfHeights = [0.22, 0.78, 1.32, 1.86];
  for (const sy of shelfHeights) {
    pushBox(steelPainted, rackW, 0.035, rackD, rackX, sy, rackZ);
  }
  // Static binders/toolboxes on top shelf + dynamic physics bottles/cans on mid shelf!
  pushBox(wood, 0.34, 0.24, 0.42, rackX, 1.46, rackZ - 0.42);
  pushBox(accentRed, 0.3, 0.2, 0.46, rackX, 0.9, rackZ + 0.45);
  addProp('glass_bottle_green', rackX, 0.81, rackZ - 0.35, 0.4);
  addProp('ration_tin', rackX, 0.81, rackZ - 0.05, 1.2);
  addProp('soda_can', rackX, 1.35, rackZ + 0.25, 2.1);

  // Corner B: South-West desk or industrial workbench + chair + wall tactical corkboard
  const deskX = -halfW + inset + 0.58;
  const deskZ = halfD - inset - 1.45;
  const deskW = 0.86;
  const deskD = 1.72;
  const deskH = 0.78;
  // Tabletop + 4 steel legs + side drawer pedestal
  pushBox(
    spec.theme === 'industrial_garage' ? steelPainted : wood,
    deskW,
    0.055,
    deskD,
    deskX,
    deskH,
    deskZ,
  );
  for (const lx of [-deskW * 0.44, deskW * 0.44]) {
    for (const lz of [-deskD * 0.44, deskD * 0.44]) {
      pushBox(steelDark, 0.05, deskH - 0.03, 0.05, deskX + lx, (deskH - 0.03) * 0.5, deskZ + lz);
    }
  }
  pushBox(steelPainted, deskW - 0.12, 0.56, 0.46, deskX, 0.34, deskZ + deskD * 0.26);
  // Pushed-aside tactical folding chair facing desk
  const chairX = deskX + 0.72;
  const chairZ = deskZ - 0.15;
  pushBox(wood, 0.42, 0.04, 0.42, chairX, 0.46, chairZ, 0.28);
  pushBox(wood, 0.04, 0.44, 0.4, chairX + 0.18, 0.68, chairZ - 0.05, 0.28);
  pushBox(steelDark, 0.04, 0.45, 0.04, chairX - 0.16, 0.225, chairZ - 0.16);
  pushBox(steelDark, 0.04, 0.45, 0.04, chairX + 0.16, 0.225, chairZ - 0.16);
  pushBox(steelDark, 0.04, 0.45, 0.04, chairX - 0.16, 0.225, chairZ + 0.16);
  pushBox(steelDark, 0.04, 0.45, 0.04, chairX + 0.16, 0.225, chairZ + 0.16);

  // Wall corkboard / pegboard mounted above desk
  pushBox(trim, 0.05, 0.86, 1.32, -halfW + inset + 0.04, 1.56, deskZ);
  pushBox(board, 0.03, 0.78, 1.24, -halfW + inset + 0.06, 1.56, deskZ);

  // Grounded interactive physics clutter on desk surface!
  addProp('paper_sheet', deskX - 0.08, deskH + 0.035, deskZ - 0.32, 0.24);
  addProp('paper_sheet', deskX + 0.06, deskH + 0.04, deskZ - 0.04, -0.45);
  addProp('glass_bottle_amber', deskX - 0.12, deskH + 0.035, deskZ + 0.36, 0.9);
  addProp('soda_can', deskX + 0.14, deskH + 0.035, deskZ + 0.54, 1.7);

  // Corner C: Tall steel filing cabinet or fuel drum near South-East corner (clear of South doorway)
  const cabX = halfW - inset - 0.38;
  const cabZ = halfD - inset - 0.85;
  if (spec.theme === 'industrial_garage') {
    // Weathered steel oil drum + wooden pallet
    pushCylinder(accentRed, 0.29, 0.29, 0.88, 10, cabX, 0.44, cabZ);
    pushBox(wood, 0.95, 0.12, 0.95, cabX - 0.2, 0.06, cabZ - 1.15);
    addProp('cardboard_box', cabX - 0.2, 0.14, cabZ - 1.15, 0.32);
    addProp('glass_bottle_green', cabX, 0.9, cabZ, 0.6);
  } else {
    // 4-drawer Soviet steel filing cabinet
    pushBox(steelPainted, 0.52, 1.34, 0.56, cabX, 0.67, cabZ);
    for (let d = 0; d < 4; d++) {
      pushBox(steelDark, 0.04, 0.04, 0.18, cabX - 0.27, 0.24 + d * 0.31, cabZ);
    }
    addProp('paper_sheet', cabX, 1.36, cabZ, 0.5);
    addProp('ration_tin', cabX - 0.08, 1.36, cabZ + 0.12, 2.2);
  }

  // Loose floor clutter (papers, kicked cans, bottles) in safe off-center spots
  addProp('paper_sheet', -W * 0.06, 0.02, D * 0.14, 0.8);
  addProp('soda_can', W * 0.12, 0.02, -D * 0.06, 1.4, Math.PI * 0.5);
  addProp('cardboard_box', -W * 0.22, 0.02, -D * 0.34, 0.25);

  // Merge each material bucket into ONE single static draw call!
  const buckets = [steelDark, steelPainted, wood, accentRed, trim, board];
  for (const b of buckets) {
    if (b.geos.length === 0) continue;
    const merged = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
    if (b.geos.length > 1) {
      for (const g of b.geos) g.dispose();
    }
    if (!merged) continue;
    const mesh = new THREE.Mesh(trackGeo(merged), b.mat);
    mesh.castShadow = !isSoftwareGl;
    mesh.receiveShadow = !isSoftwareGl;
    mesh.userData.surfaceMaterial = b.surface;
    group.add(mesh);
  }

  return { group, propSpawns };
}

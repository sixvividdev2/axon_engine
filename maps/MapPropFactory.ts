import * as THREE from 'three';
import { BodycamPhysicsWorld } from '../bodycam-sdk';
import {
  applyWindFoliageShader,
  assignHeightSwayAttribute,
  WindShaderUniforms,
} from '../engine/world/WindFoliageShader';
import {
  createBirchBarkTextureSet,
  createBirchLeafClusterTexture,
  createFernFrondTexture,
  createGraniteBoulderTextureSet,
  createGrassClumpTexture,
  createPineBarkTextureSet,
  createPineNeedleTexture,
  createShrubBranchTexture,
} from './MapTextures';

export type TrackGeoFn = <T extends THREE.BufferGeometry>(g: T) => T;
export type TrackMatFn = <T extends THREE.Material>(m: T) => T;
export type TrackTexFn = <T extends THREE.Texture>(t: T) => T;

export interface PropFactoryContext {
  sceneGroup: THREE.Group;
  physics: BodycamPhysicsWorld;
  raycastMeshes: THREE.Object3D[];
  isSoftwareGl: boolean;
  trackGeo: TrackGeoFn;
  trackMat: TrackMatFn;
  trackTex?: TrackTexFn;
  windUniforms?: WindShaderUniforms | null;
  maxAniso?: number;
}

export interface VehicleMaterials {
  body: THREE.Material;
  rust: THREE.Material;
  tire: THREE.Material;
  rim: THREE.Material;
  darkInterior: THREE.Material;
  glass: THREE.Material;
  chrome: THREE.Material;
}

/**
 * Builds a detailed, bottom-center grounded (y = 0) rusted Soviet vehicle or utility truck
 * composed of 12+ distinct sub-parts (body, sloped hood, roof pillars, recessed cab, bumpers,
 * headlights, grille, 4 tires with rusted rims, axles, and optional crooked ajar door).
 */
export function buildRustedVehicle(
  ctx: PropFactoryContext,
  style: 'lada' | 'moskvitch' | 'zil_truck' | 'pickup',
  x: number,
  y: number,
  z: number,
  yaw: number,
  mats: VehicleMaterials,
  addCollider = true,
): THREE.Group {
  const { sceneGroup, physics, raycastMeshes, isSoftwareGl, trackGeo } = ctx;
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = yaw;

  const isTruck = style === 'zil_truck';
  const isPickup = style === 'pickup';
  const bodyLen = isTruck ? 5.8 : isPickup ? 4.7 : style === 'lada' ? 4.15 : 4.28;
  const bodyW = isTruck ? 2.25 : isPickup ? 1.88 : 1.66;
  const wheelR = isTruck ? 0.46 : isPickup ? 0.37 : 0.31;
  const wheelW = isTruck ? 0.28 : 0.22;
  const chassisY = wheelR + 0.22;

  const addPart = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    px: number,
    py: number,
    pz: number,
    rx = 0,
    ry = 0,
    rz = 0,
    castShadow = true,
  ): THREE.Mesh => {
    const m = new THREE.Mesh(trackGeo(geo), mat);
    m.position.set(px, py, pz);
    m.rotation.set(rx, ry, rz);
    m.castShadow = !isSoftwareGl && castShadow;
    m.receiveShadow = !isSoftwareGl;
    m.userData.surfaceMaterial = 'metal';
    g.add(m);
    raycastMeshes.push(m);
    return m;
  };

  // 1. Underbody chassis frame rail
  addPart(new THREE.BoxGeometry(bodyW - 0.16, 0.22, bodyLen - 0.2), mats.rust, 0, chassisY, 0);

  // 2. Lower body tub / fenders
  if (isTruck) {
    // Cab lower section + long cargo bed
    addPart(new THREE.BoxGeometry(bodyW, 0.72, 2.2), mats.body, 0, chassisY + 0.42, bodyLen * 0.5 - 1.15);
    addPart(new THREE.BoxGeometry(bodyW + 0.08, 0.22, 3.3), mats.rust, 0, chassisY + 0.28, -bodyLen * 0.5 + 1.68);
    // Wooden/rusted cargo sideboards
    addPart(new THREE.BoxGeometry(0.1, 0.85, 3.25), mats.rust, -bodyW * 0.5, chassisY + 0.78, -bodyLen * 0.5 + 1.68);
    addPart(new THREE.BoxGeometry(0.1, 0.85, 3.25), mats.rust, bodyW * 0.5, chassisY + 0.78, -bodyLen * 0.5 + 1.68);
    addPart(new THREE.BoxGeometry(bodyW + 0.04, 0.82, 0.1), mats.rust, 0, chassisY + 0.78, -bodyLen * 0.5 + 0.08);
    // Cab upper greenhouse
    addPart(new THREE.BoxGeometry(bodyW - 0.14, 0.72, 1.45), mats.darkInterior, 0, chassisY + 1.08, bodyLen * 0.5 - 1.55);
    addPart(new THREE.BoxGeometry(bodyW - 0.04, 0.12, 1.55), mats.body, 0, chassisY + 1.48, bodyLen * 0.5 - 1.55);
    // Sloped truck hood
    addPart(new THREE.BoxGeometry(bodyW - 0.28, 0.55, 1.18), mats.body, 0, chassisY + 0.78, bodyLen * 0.5 - 0.62, 0.05);
  } else if (isPickup) {
    addPart(new THREE.BoxGeometry(bodyW, 0.58, bodyLen), mats.body, 0, chassisY + 0.36, 0);
    // Pickup cab + bed walls
    addPart(new THREE.BoxGeometry(bodyW - 0.12, 0.62, 1.5), mats.darkInterior, 0, chassisY + 0.92, 0.22);
    addPart(new THREE.BoxGeometry(bodyW - 0.08, 0.1, 1.58), mats.body, 0, chassisY + 1.26, 0.22);
    // Bed side lips
    addPart(new THREE.BoxGeometry(0.12, 0.42, 1.8), mats.body, -bodyW * 0.46, chassisY + 0.74, -bodyLen * 0.5 + 0.94);
    addPart(new THREE.BoxGeometry(0.12, 0.42, 1.8), mats.body, bodyW * 0.46, chassisY + 0.74, -bodyLen * 0.5 + 0.94);
    addPart(new THREE.BoxGeometry(bodyW, 0.42, 0.12), mats.rust, 0, chassisY + 0.74, -bodyLen * 0.5 + 0.08);
  } else {
    // Classic Soviet boxy sedan (VAZ-2101 Lada / Moskvitch-412)
    addPart(new THREE.BoxGeometry(bodyW, 0.54, bodyLen), mats.body, 0, chassisY + 0.34, 0);
    // Slightly sloped hood & rusted trunk lid
    addPart(new THREE.BoxGeometry(bodyW - 0.08, 0.08, 1.22), mats.rust, 0, chassisY + 0.63, bodyLen * 0.5 - 0.66, 0.04);
    addPart(new THREE.BoxGeometry(bodyW - 0.08, 0.08, 0.96), mats.body, 0, chassisY + 0.62, -bodyLen * 0.5 + 0.54, -0.03);
    // Recessed dark cabin + roof + 4 pillars
    addPart(new THREE.BoxGeometry(bodyW - 0.22, 0.52, 1.75), mats.darkInterior, 0, chassisY + 0.84, -0.1);
    addPart(new THREE.BoxGeometry(bodyW - 0.14, 0.09, 1.88), mats.body, 0, chassisY + 1.14, -0.1);
    // Shattered windshield glass frame (angled)
    addPart(new THREE.BoxGeometry(bodyW - 0.18, 0.54, 0.05), mats.glass, 0, chassisY + 0.86, 0.84, -0.34);
    addPart(new THREE.BoxGeometry(bodyW - 0.18, 0.48, 0.05), mats.glass, 0, chassisY + 0.86, -1.04, 0.32);
    // Crooked ajar driver door for abandoned silhouette
    addPart(new THREE.BoxGeometry(0.08, 0.52, 0.96), mats.body, -bodyW * 0.5 - 0.2, chassisY + 0.38, 0.14, 0, 0.42, 0.05);
  }

  // 3. Front radiator grille, chrome/rusted bumpers & round headlight bezels
  addPart(new THREE.BoxGeometry(bodyW + 0.08, 0.14, 0.16), mats.chrome, 0, chassisY + 0.14, bodyLen * 0.5 + 0.06);
  addPart(new THREE.BoxGeometry(bodyW + 0.08, 0.14, 0.16), mats.rust, 0, chassisY + 0.14, -bodyLen * 0.5 - 0.06);
  addPart(new THREE.BoxGeometry(bodyW - 0.36, 0.24, 0.08), mats.darkInterior, 0, chassisY + 0.42, bodyLen * 0.5 + 0.03);
  for (const side of [-1, 1]) {
    addPart(
      new THREE.CylinderGeometry(0.09, 0.09, 0.08, 10),
      mats.chrome,
      side * (bodyW * 0.36),
      chassisY + 0.42,
      bodyLen * 0.5 + 0.04,
      Math.PI * 0.5,
      0,
      0,
      false,
    );
  }

  // 4. Axles & 4 wheels with tires + rusted steel rims (bottom touches y = 0)
  const wheelZPositions = [bodyLen * 0.33, -bodyLen * 0.33];
  const tireGeo = trackGeo(new THREE.CylinderGeometry(wheelR, wheelR, wheelW, 14));
  tireGeo.rotateZ(Math.PI * 0.5);
  const rimGeo = trackGeo(new THREE.CylinderGeometry(wheelR * 0.56, wheelR * 0.56, wheelW + 0.03, 10));
  rimGeo.rotateZ(Math.PI * 0.5);

  for (const wz of wheelZPositions) {
    addPart(new THREE.BoxGeometry(bodyW - 0.2, 0.1, 0.1), mats.rust, 0, wheelR, wz, 0, 0, 0, false);
    for (const side of [-1, 1]) {
      const wx = side * (bodyW * 0.5 - 0.02);
      const tire = new THREE.Mesh(tireGeo, mats.tire);
      tire.position.set(wx, wheelR, wz);
      tire.castShadow = !isSoftwareGl;
      tire.receiveShadow = !isSoftwareGl;
      g.add(tire);

      const rim = new THREE.Mesh(rimGeo, mats.rim);
      rim.position.set(wx, wheelR, wz);
      g.add(rim);
    }
  }

  sceneGroup.add(g);

  // Conservative rotated AABB physics collider
  if (addCollider) {
    const cos = Math.abs(Math.cos(yaw));
    const sin = Math.abs(Math.sin(yaw));
    const halfX = (bodyW * cos + bodyLen * sin) * 0.5;
    const halfZ = (bodyW * sin + bodyLen * cos) * 0.5;
    const totalH = isTruck ? chassisY + 1.54 : isPickup ? chassisY + 1.32 : chassisY + 1.18;
    physics.addBox({
      minX: x - halfX,
      maxX: x + halfX,
      minY: y,
      maxY: y + totalH,
      minZ: z - halfZ,
      maxZ: z + halfZ,
      surface: 'metal',
      blocksMovement: true,
    });
  }

  return g;
}

/**
 * Builds a realistic 15-part military utility helicopter prop grounded at y = 0 (bottom of skids).
 * Purely static prop for helipad centerpiece with crisp silhouette, rotor assembly, & cockpit canopy.
 */
export function buildRealisticHelicopterProp(
  ctx: PropFactoryContext,
  x: number,
  y: number,
  z: number,
  yaw: number,
): THREE.Group {
  const { sceneGroup, physics, raycastMeshes, isSoftwareGl, trackGeo, trackMat } = ctx;
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = yaw;

  const matHull = trackMat(new THREE.MeshStandardMaterial({ color: 0x3b4438, roughness: 0.62, metalness: 0.32 }));
  const matHullDark = trackMat(new THREE.MeshStandardMaterial({ color: 0x262c25, roughness: 0.58, metalness: 0.45 }));
  const matGlass = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x16242c, roughness: 0.14, metalness: 0.82 }),
  );
  const matSteel = trackMat(new THREE.MeshStandardMaterial({ color: 0x2f3438, roughness: 0.42, metalness: 0.78 }));
  const matStripe = trackMat(new THREE.MeshStandardMaterial({ color: 0xc2983c, roughness: 0.5, metalness: 0.2 }));

  const add = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    px: number,
    py: number,
    pz: number,
    rx = 0,
    ry = 0,
    rz = 0,
  ): THREE.Mesh => {
    const m = new THREE.Mesh(trackGeo(geo), mat);
    m.position.set(px, py, pz);
    m.rotation.set(rx, ry, rz);
    m.castShadow = !isSoftwareGl;
    m.receiveShadow = !isSoftwareGl;
    m.userData.surfaceMaterial = 'metal';
    g.add(m);
    raycastMeshes.push(m);
    return m;
  };

  // 1. Twin tubular landing skids (grounded at y = 0.08) + 4 angled cross-struts
  for (const sx of [-1.22, 1.22]) {
    add(new THREE.CylinderGeometry(0.075, 0.075, 5.4, 10), matSteel, sx, 0.08, 0.2, Math.PI * 0.5);
    // Upturned front skid tips
    add(new THREE.CylinderGeometry(0.072, 0.075, 0.75, 10), matSteel, sx, 0.26, 3.16, Math.PI * 0.34);
    for (const sz of [-1.05, 1.25]) {
      add(new THREE.CylinderGeometry(0.055, 0.055, 0.96, 8), matSteel, sx * 0.84, 0.52, sz, 0, 0, sx > 0 ? 0.32 : -0.32);
    }
  }

  // 2. Main armored fuselage belly + cabin hull
  add(new THREE.BoxGeometry(2.26, 1.56, 4.9), matHull, 0, 1.62, 0.15);
  // Sloped nose cone & radar radome
  add(new THREE.BoxGeometry(2.02, 0.92, 1.85), matHull, 0, 1.32, 3.18, 0.22);
  add(new THREE.SphereGeometry(0.68, 12, 10), matHullDark, 0, 1.15, 3.95);
  // Tinted armored cockpit windshield + canopy struts
  add(new THREE.BoxGeometry(1.94, 0.86, 1.24), matGlass, 0, 1.98, 2.74, 0.42);
  add(new THREE.BoxGeometry(0.1, 0.92, 1.26), matHullDark, 0, 2.0, 2.76, 0.42);
  // Recessed side sliding troop doors
  for (const sx of [-1.14, 1.14]) {
    add(new THREE.BoxGeometry(0.08, 1.12, 1.75), matHullDark, sx, 1.58, -0.15);
    add(new THREE.BoxGeometry(0.09, 0.42, 0.62), matGlass, sx * 1.01, 1.78, 0.05);
  }

  // 3. Twin top turbine engine nacelles + darkened exhaust ports
  for (const sx of [-0.62, 0.62]) {
    add(new THREE.CylinderGeometry(0.38, 0.42, 2.65, 12), matHullDark, sx, 2.66, -0.35, Math.PI * 0.5);
    add(new THREE.CylinderGeometry(0.24, 0.28, 0.55, 10), matSteel, sx, 2.68, -1.78, Math.PI * 0.5);
  }
  add(new THREE.BoxGeometry(1.2, 0.46, 2.4), matHull, 0, 2.62, 0.05);

  // 4. Tapered tail boom + caution stripe + vertical tail fin + horizontal stabilizers
  add(new THREE.CylinderGeometry(0.26, 0.54, 6.2, 10), matHull, 0, 1.92, -5.2, Math.PI * 0.5);
  add(new THREE.CylinderGeometry(0.32, 0.34, 0.45, 10), matStripe, 0, 1.92, -6.9, Math.PI * 0.5);
  // Vertical tail fin
  add(new THREE.BoxGeometry(0.24, 2.05, 1.25), matHull, 0, 2.75, -8.05, -0.28);
  // Horizontal tail stabilizers
  add(new THREE.BoxGeometry(2.6, 0.14, 0.68), matHullDark, 0, 1.96, -7.25);

  // 5. Main Rotor Mast, Swashplate Hub & 4 Long Rotor Blades
  add(new THREE.CylinderGeometry(0.16, 0.22, 0.85, 12), matSteel, 0, 3.12, 0.2);
  add(new THREE.CylinderGeometry(0.42, 0.42, 0.22, 12), matHullDark, 0, 3.55, 0.2);
  for (let b = 0; b < 4; b++) {
    const angle = b * (Math.PI * 0.5) + 0.35;
    const blade = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.32, 0.05, 5.4)), matHullDark);
    blade.position.set(Math.sin(angle) * 2.85, 3.56, 0.2 + Math.cos(angle) * 2.85);
    blade.rotation.y = angle;
    blade.rotation.x = 0.03; // gentle static droop
    blade.castShadow = !isSoftwareGl;
    g.add(blade);
    // Yellow blade tip stripe
    const tip = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.33, 0.055, 0.42)), matStripe);
    tip.position.set(Math.sin(angle) * 5.32, 3.48, 0.2 + Math.cos(angle) * 5.32);
    tip.rotation.y = angle;
    g.add(tip);
  }

  // 6. Tail Rotor Hub & 2 Blades
  add(new THREE.CylinderGeometry(0.12, 0.12, 0.36, 8), matSteel, 0.22, 3.35, -8.35, 0, 0, Math.PI * 0.5);
  add(new THREE.BoxGeometry(0.05, 1.7, 0.16), matHullDark, 0.36, 3.35, -8.35, 0.4);
  add(new THREE.BoxGeometry(0.05, 0.16, 1.7), matHullDark, 0.36, 3.35, -8.35, 0.4);

  sceneGroup.add(g);

  // Physics collider around the main fuselage so players can take cover behind the chopper
  const cos = Math.abs(Math.cos(yaw));
  const sin = Math.abs(Math.sin(yaw));
  const halfX = (2.6 * cos + 7.2 * sin) * 0.5;
  const halfZ = (2.6 * sin + 7.2 * cos) * 0.5;
  physics.addBox({
    minX: x - halfX,
    maxX: x + halfX,
    minY: y,
    maxY: y + 2.8,
    minZ: z - halfZ,
    maxZ: z + halfZ,
    surface: 'metal',
    blocksMovement: true,
  });

  return g;
}

/**
 * Builds a tall steel lattice military Radar & Communications Tower grounded at y = 0,
 * featuring 4 tapered legs, horizontal & diagonal cross-bracing, elevated service deck + rails,
 * rotating parabolic radar dish, and glowing red aviation obstruction beacon.
 */
export function buildRadarTower(
  ctx: PropFactoryContext,
  x: number,
  y: number,
  z: number,
  height = 17.5,
): { group: THREE.Group; dishPivot: THREE.Group; beaconMat: THREE.MeshStandardMaterial } {
  const { sceneGroup, physics, raycastMeshes, isSoftwareGl, trackGeo, trackMat } = ctx;
  const group = new THREE.Group();
  group.position.set(x, y, z);

  const matSteel = trackMat(new THREE.MeshStandardMaterial({ color: 0x525a60, roughness: 0.54, metalness: 0.72 }));
  const matDish = trackMat(new THREE.MeshStandardMaterial({ color: 0x9aa3a6, roughness: 0.48, metalness: 0.42, side: THREE.DoubleSide }));
  const matConcrete = trackMat(new THREE.MeshStandardMaterial({ color: 0x626664, roughness: 0.92, metalness: 0.04 }));
  const beaconMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xff2b2b, emissive: 0xff2424, emissiveIntensity: 2.6, roughness: 0.2 }),
  );

  // Concrete footing pad
  const pad = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(5.2, 0.4, 5.2)), matConcrete);
  pad.position.y = 0.2;
  pad.receiveShadow = !isSoftwareGl;
  group.add(pad);
  raycastMeshes.push(pad);

  // 4 tapered corner steel legs
  const baseHalf = 2.05;
  const topHalf = 0.95;
  const deckY = height - 2.6;
  const tiers = 5;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const p0 = new THREE.Vector3(sx * baseHalf, 0.4, sz * baseHalf);
      const p1 = new THREE.Vector3(sx * topHalf, deckY, sz * topHalf);
      const dir = p1.clone().sub(p0);
      const len = dir.length();
      const leg = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.1, 0.14, len, 6)), matSteel);
      leg.position.copy(p0).add(p1).multiplyScalar(0.5);
      leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      leg.castShadow = !isSoftwareGl;
      group.add(leg);
    }
  }

  // Horizontal rings & X-bracing per tier
  for (let t = 0; t < tiers; t++) {
    const f0 = t / tiers;
    const f1 = (t + 1) / tiers;
    const y0 = 0.4 + f0 * (deckY - 0.4);
    const y1 = 0.4 + f1 * (deckY - 0.4);
    const h0 = THREE.MathUtils.lerp(baseHalf, topHalf, f0);
    const h1 = THREE.MathUtils.lerp(baseHalf, topHalf, f1);

    // Horizontal girts at y1
    const span = h1 * 2;
    for (const s of [-1, 1]) {
      const gx = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(span, 0.1, 0.1)), matSteel);
      gx.position.set(0, y1, s * h1);
      group.add(gx);
      const gz = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.1, 0.1, span)), matSteel);
      gz.position.set(s * h1, y1, 0);
      group.add(gz);
    }

    // Diagonal cross-braces on all 4 faces
    const diagLen = Math.hypot((h0 + h1), y1 - y0);
    const diagAngle = Math.atan2(y1 - y0, h0 + h1);
    const ym = (y0 + y1) * 0.5;
    const hm = (h0 + h1) * 0.5;
    for (const s of [-1, 1]) {
      const d1 = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(diagLen, 0.06, 0.06)), matSteel);
      d1.position.set(0, ym, s * hm);
      d1.rotation.z = diagAngle;
      group.add(d1);
      const d2 = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.06, 0.06, diagLen)), matSteel);
      d2.position.set(s * hm, ym, 0);
      d2.rotation.x = diagAngle;
      group.add(d2);
    }
  }

  // Elevated equipment platform + safety railing
  const deck = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(3.4, 0.18, 3.4)), matSteel);
  deck.position.y = deckY;
  deck.castShadow = !isSoftwareGl;
  group.add(deck);
  for (const s of [-1, 1]) {
    const rX = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(3.4, 0.08, 0.08)), matSteel);
    rX.position.set(0, deckY + 1.05, s * 1.66);
    group.add(rX);
    const rZ = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.08, 0.08, 3.4)), matSteel);
    rZ.position.set(s * 1.66, deckY + 1.05, 0);
    group.add(rZ);
  }

  // Rotating Parabolic Radar Dish assembly
  const dishPivot = new THREE.Group();
  dishPivot.position.set(0, deckY + 1.35, 0);
  const mast = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.18, 0.24, 1.5, 10)), matSteel);
  mast.position.y = 0.4;
  dishPivot.add(mast);

  // Curved radar reflector bowl (LatheGeometry)
  const dishPts = [
    new THREE.Vector2(0.02, 0.0),
    new THREE.Vector2(0.65, 0.12),
    new THREE.Vector2(1.35, 0.36),
    new THREE.Vector2(1.95, 0.72),
  ];
  const dishMesh = new THREE.Mesh(trackGeo(new THREE.LatheGeometry(dishPts, 18)), matDish);
  dishMesh.rotation.x = Math.PI * 0.44;
  dishMesh.position.set(0, 1.15, 0.25);
  dishMesh.castShadow = !isSoftwareGl;
  dishPivot.add(dishMesh);

  // Feedhorn spike
  const feed = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.06, 0.08, 1.25, 8)), matSteel);
  feed.rotation.x = Math.PI * 0.44;
  feed.position.set(0, 1.28, 0.98);
  dishPivot.add(feed);

  // Top spire + blinking red aviation beacon
  const spire = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.04, 0.07, 2.2, 6)), matSteel);
  spire.position.set(0, 2.25, -0.35);
  dishPivot.add(spire);
  const beacon = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.18, 10, 10)), beaconMat);
  beacon.position.set(0, 3.4, -0.35);
  dishPivot.add(beacon);

  group.add(dishPivot);
  sceneGroup.add(group);

  // Base footing collider
  physics.addBox({
    minX: x - 2.3,
    maxX: x + 2.3,
    minY: y,
    maxY: y + 4.5,
    minZ: z - 2.3,
    maxZ: z + 2.3,
    surface: 'metal',
    blocksMovement: true,
  });

  return { group, dishPivot, beaconMat };
}

/** Composite Soviet/Office Wooden Desk with drawer pedestal & legs (grounded at y = 0) */
export function buildOfficeDesk(
  ctx: PropFactoryContext,
  x: number,
  y: number,
  z: number,
  yaw: number,
  matWood: THREE.Material,
  matDarkMetal: THREE.Material,
  addCollider = true,
): THREE.Group {
  const { sceneGroup, physics, raycastMeshes, isSoftwareGl, trackGeo } = ctx;
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = yaw;

  const top = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.56, 0.08, 0.82)), matWood);
  top.position.y = 0.78;
  const drawers = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.46, 0.72, 0.72)), matWood);
  drawers.position.set(0.48, 0.38, 0);
  const legL1 = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.08, 0.74, 0.08)), matDarkMetal);
  legL1.position.set(-0.68, 0.37, -0.32);
  const legL2 = legL1.clone();
  legL2.position.set(-0.68, 0.37, 0.32);
  const modesty = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.05, 0.44, 0.05)), matWood);
  modesty.position.set(-0.18, 0.5, -0.3);

  for (const m of [top, drawers, legL1, legL2, modesty]) {
    m.castShadow = !isSoftwareGl;
    m.receiveShadow = !isSoftwareGl;
    m.userData.surfaceMaterial = 'wood';
    g.add(m);
  }
  raycastMeshes.push(top, drawers);
  sceneGroup.add(g);

  if (addCollider) {
    const cos = Math.abs(Math.cos(yaw));
    const sin = Math.abs(Math.sin(yaw));
    const hx = (1.56 * cos + 0.82 * sin) * 0.5;
    const hz = (1.56 * sin + 0.82 * cos) * 0.5;
    physics.addBox({
      minX: x - hx,
      maxX: x + hx,
      minY: y,
      maxY: y + 0.84,
      minZ: z - hz,
      maxZ: z + hz,
      surface: 'wood',
      blocksMovement: true,
    });
  }
  return g;
}

/** Composite Armory Weapon Rack with vertical rifle silhouettes & metal shelving */
export function buildArmoryWeaponRack(
  ctx: PropFactoryContext,
  x: number,
  y: number,
  z: number,
  yaw: number,
  matSteel: THREE.Material,
  matGunMetal: THREE.Material,
  matWoodStock: THREE.Material,
): THREE.Group {
  const { sceneGroup, physics, raycastMeshes, isSoftwareGl, trackGeo } = ctx;
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = yaw;

  const base = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.85, 0.14, 0.58)), matSteel);
  base.position.y = 0.07;
  const back = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.85, 1.95, 0.06)), matSteel);
  back.position.set(0, 1.04, -0.25);
  const topBar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.85, 0.08, 0.42)), matSteel);
  topBar.position.set(0, 1.98, -0.07);
  const midRest = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.8, 0.06, 0.24)), matSteel);
  midRest.position.set(0, 1.15, -0.14);

  g.add(base, back, topBar, midRest);

  // 5 racked rifle silhouettes
  for (let i = -2; i <= 2; i++) {
    const rx = i * 0.34;
    const stock = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.06, 0.42, 0.1)), matWoodStock);
    stock.position.set(rx, 0.36, -0.08);
    const receiver = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.055, 0.46, 0.09)), matGunMetal);
    receiver.position.set(rx, 0.8, -0.08);
    const barrel = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.016, 0.018, 0.56, 6)), matGunMetal);
    barrel.position.set(rx, 1.32, -0.08);
    g.add(stock, receiver, barrel);
  }

  g.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = !isSoftwareGl;
      obj.receiveShadow = !isSoftwareGl;
      obj.userData.surfaceMaterial = 'metal';
    }
  });
  raycastMeshes.push(back);
  sceneGroup.add(g);

  const cos = Math.abs(Math.cos(yaw));
  const sin = Math.abs(Math.sin(yaw));
  const hx = (1.88 * cos + 0.62 * sin) * 0.5;
  const hz = (1.88 * sin + 0.62 * cos) * 0.5;
  physics.addBox({
    minX: x - hx,
    maxX: x + hx,
    minY: y,
    maxY: y + 2.02,
    minZ: z - hz,
    maxZ: z + hz,
    surface: 'metal',
    blocksMovement: true,
  });

  return g;
}

/**
 * Merges multiple BufferGeometries (converting indexed -> non-indexed cleanly) into a single
 * GPU-friendly BufferGeometry with position, normal, uv, optional vertex color, and optional aSway.
 * Disposes every source geometry after copying to guarantee zero leaked GPU buffers.
 */
function mergePartsToSingleGeometry(
  parts: THREE.BufferGeometry[],
  includeColor: boolean,
  includeSway: boolean,
): THREE.BufferGeometry {
  const converted: THREE.BufferGeometry[] = [];
  let totalVerts = 0;

  for (let i = 0; i < parts.length; i++) {
    const src = parts[i];
    const g = src.index ? src.toNonIndexed() : src;
    if (g !== src) src.dispose();
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    totalVerts += g.getAttribute('position').count;
    converted.push(g);
  }

  const posOut = new Float32Array(totalVerts * 3);
  const normOut = new Float32Array(totalVerts * 3);
  const uvOut = new Float32Array(totalVerts * 2);
  const colOut = includeColor ? new Float32Array(totalVerts * 3) : null;
  const swayOut = includeSway ? new Float32Array(totalVerts) : null;

  let o3 = 0;
  let o2 = 0;
  let o1 = 0;

  for (let p = 0; p < converted.length; p++) {
    const g = converted[p];
    const pos = g.getAttribute('position');
    const norm = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    const col = includeColor ? g.getAttribute('color') : null;
    const sway = includeSway ? g.getAttribute('aSway') : null;

    for (let i = 0; i < pos.count; i++) {
      posOut[o3] = pos.getX(i);
      posOut[o3 + 1] = pos.getY(i);
      posOut[o3 + 2] = pos.getZ(i);

      normOut[o3] = norm.getX(i);
      normOut[o3 + 1] = norm.getY(i);
      normOut[o3 + 2] = norm.getZ(i);

      if (uv) {
        uvOut[o2] = uv.getX(i);
        uvOut[o2 + 1] = uv.getY(i);
      } else {
        uvOut[o2] = pos.getX(i) * 0.5 + 0.5;
        uvOut[o2 + 1] = pos.getY(i) * 0.5 + 0.5;
      }

      if (colOut) {
        if (col) {
          colOut[o3] = col.getX(i);
          colOut[o3 + 1] = col.getY(i);
          colOut[o3 + 2] = col.getZ(i);
        } else {
          colOut[o3] = 1;
          colOut[o3 + 1] = 1;
          colOut[o3 + 2] = 1;
        }
      }

      if (swayOut) {
        swayOut[o1] = sway ? sway.getX(i) : 0;
      }

      o3 += 3;
      o2 += 2;
      o1 += 1;
    }
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(posOut, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normOut, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvOut, 2));
  if (colOut) out.setAttribute('color', new THREE.BufferAttribute(colOut, 3));
  if (swayOut) out.setAttribute('aSway', new THREE.BufferAttribute(swayOut, 1));
  out.computeBoundingSphere();
  return out;
}

/** Deterministic 3D trigonometric ridge/crag noise for sculpted boulders */
function rockNoise3(x: number, y: number, z: number, seed: number): number {
  const s1 = Math.sin(x * 2.15 + y * 1.43 + seed) * Math.cos(z * 2.07 - y * 1.18 + seed * 0.7);
  const s2 = Math.sin(x * 4.61 - z * 3.89 + seed * 1.9) * Math.sin(y * 4.17 + x * 2.31);
  const s3 = Math.cos(z * 7.83 + y * 6.41 - x * 5.93 + seed * 2.3);
  // Ridged cleavage component creates realistic sharp granite edges
  const ridge = 1.0 - Math.abs(Math.sin(x * 2.9 + z * 2.4 - y * 1.7 + seed * 1.3));
  return s1 * 0.42 + s2 * 0.24 + s3 * 0.1 + (ridge - 0.5) * 0.34;
}

/**
 * Sculpts a single angular fractured rock sub-mesh with planar cleavage facets,
 * stratified displacement, flat embedded base, and baked per-vertex crevice AO + moss tint.
 */
function createSculptedRockPiece(
  radius: number,
  detail: number,
  seed: number,
  scaleX: number,
  scaleY: number,
  scaleZ: number,
  offsetX = 0,
  offsetY = 0,
  offsetZ = 0,
  rotY = 0,
): THREE.BufferGeometry {
  const base = new THREE.IcosahedronGeometry(radius, detail);
  const geo = base.index ? base.toNonIndexed() : base.clone();
  base.dispose();

  // Four deterministic oblique shear/cleavage planes give crisp geological rock faces
  const planes: Array<[number, number, number, number]> = [
    [Math.cos(seed), 0.42, Math.sin(seed), radius * 0.78],
    [Math.cos(seed + 2.1), 0.25, Math.sin(seed + 2.1), radius * 0.82],
    [Math.cos(seed + 4.3), -0.32, Math.sin(seed + 4.3), radius * 0.86],
    [0.18 * Math.sin(seed * 1.7), 0.94, 0.28 * Math.cos(seed * 1.3), radius * 0.74],
  ];

  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  const colors = new Float32Array(pos.count * 3);
  const cosR = Math.cos(rotY);
  const sinR = Math.sin(rotY);

  for (let i = 0; i < pos.count; i++) {
    let vx = pos.getX(i);
    let vy = pos.getY(i);
    let vz = pos.getZ(i);
    const len = Math.max(1e-5, Math.hypot(vx, vy, vz));
    const nx = vx / len;
    const ny = vy / len;
    const nz = vz / len;

    // Multi-octave crag & strata displacement
    const n = rockNoise3(nx, ny, nz, seed);
    const strata = Math.sin(ny * 8.5 + nx * 2.2 + seed) * 0.055;
    let rMod = 1.0 + n * 0.26 + strata;

    vx = nx * radius * rMod;
    vy = ny * radius * rMod;
    vz = nz * radius * rMod;

    // Apply planar fracture cleavage clipping for authentic chiseled rock faces
    for (let p = 0; p < planes.length; p++) {
      const [px, py, pz, dLim] = planes[p];
      const dot = vx * px + vy * py + vz * pz;
      if (dot > dLim) {
        const push = (dot - dLim) * 0.76;
        vx -= px * push;
        vy -= py * push;
        vz -= pz * push;
      }
    }

    // Flatten embedded underside so boulders sit heavily anchored in soil
    if (vy < -radius * 0.45) {
      vy = -radius * 0.45 + (vy + radius * 0.45) * 0.22;
    }

    // Non-uniform rock proportions + local rotation + offset
    const sx = vx * scaleX;
    const sy = vy * scaleY;
    const sz = vz * scaleZ;
    const rx = sx * cosR - sz * sinR + offsetX;
    const rz = sx * sinR + sz * cosR + offsetZ;
    const ry = sy + offsetY;
    pos.setXYZ(i, rx, ry, rz);

    // Triplanar-style seam-free UVs for crisp stone texture at every viewing angle
    uv.setXY(i, (rx + rz) * 0.42 + 0.5, ry * 0.58 + (rx - rz) * 0.16 + 0.5);

    // Baked crevice AO (darkens base & crevices; subtle mossy warmth on sun-exposed top ledges)
    const heightNorm = THREE.MathUtils.clamp((sy / Math.max(0.2, radius * scaleY) + 0.55) / 1.35, 0, 1);
    const creviceAO = THREE.MathUtils.clamp(0.62 + n * 0.36 + heightNorm * 0.34, 0.46, 1.12);
    const mossLift = heightNorm > 0.62 && ny > 0.38 ? (heightNorm - 0.62) * 0.26 : 0;
    colors[i * 3] = Math.min(1.1, creviceAO * (1.0 - mossLift * 0.22));
    colors[i * 3 + 1] = Math.min(1.12, creviceAO * (1.0 + mossLift * 0.18));
    colors[i * 3 + 2] = Math.min(1.08, creviceAO * (1.0 - mossLift * 0.32));
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

export interface BoulderSpot {
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
  /** Optional variant override (0 = large crag boulder, 1 = multi-stone outcrop cluster) */
  variant?: 0 | 1;
  /** Optional per-instance stone tint */
  tint?: THREE.Color;
}

/**
 * Renders high-detail fractured granite boulders & layered multi-stone rock outcrops using
 * only 1–2 InstancedMesh draw calls total (zero FPS impact vs raw dodecahedra!), backed by
 * cracked-granite albedo/bump/roughness PBR maps, baked crevice AO, and fast analytical AABB colliders.
 */
export function buildInstancedSculptedBoulders(
  ctx: PropFactoryContext,
  spots: BoulderSpot[],
  options?: {
    castShadow?: boolean;
    receiveShadow?: boolean;
    addColliders?: boolean;
    colliderBounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
    seed?: number;
  },
): THREE.InstancedMesh[] {
  if (spots.length === 0) return [];
  const { sceneGroup, physics, raycastMeshes, isSoftwareGl, trackGeo, trackMat, trackTex, maxAniso } = ctx;
  const regTex = <T extends THREE.Texture>(t: T): T => (trackTex ? trackTex(t) : t);

  const rockTex = createGraniteBoulderTextureSet(maxAniso ?? 4, options?.seed ?? 5401);
  regTex(rockTex.map);
  regTex(rockTex.bumpMap);
  regTex(rockTex.roughnessMap);

  const matRock = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: rockTex.map,
      bumpMap: rockTex.bumpMap,
      bumpScale: 0.085,
      roughnessMap: rockTex.roughnessMap,
      roughness: 0.94,
      metalness: 0.04,
      vertexColors: true,
    }),
  );

  // Archetype 0: Sculpted angular crag boulder with fractured facets & embedded skirt
  const cragGeo = trackGeo(
    mergePartsToSingleGeometry(
      [
        createSculptedRockPiece(1.08, 2, 1.37, 1.05, 0.86, 0.96, 0, 0.14, 0, 0),
        createSculptedRockPiece(0.46, 1, 4.19, 1.15, 0.52, 0.92, 0.72, -0.18, 0.44, 0.9),
      ],
      true,
      false,
    ),
  );

  // Archetype 1: Layered multi-stone geological outcrop / talus cluster (3 stones merged into 1 draw call!)
  const outcropGeo = trackGeo(
    mergePartsToSingleGeometry(
      [
        createSculptedRockPiece(1.02, 2, 2.83, 1.18, 0.78, 0.94, -0.12, 0.12, -0.05, 0.2),
        createSculptedRockPiece(0.68, 1, 6.11, 0.95, 0.64, 1.08, 0.68, -0.04, 0.36, 1.35),
        createSculptedRockPiece(0.48, 1, 9.47, 1.12, 0.48, 0.85, -0.64, -0.16, 0.48, -0.7),
      ],
      true,
      false,
    ),
  );

  const group0: BoulderSpot[] = [];
  const group1: BoulderSpot[] = [];
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    const v = s.variant ?? ((i % 2) as 0 | 1);
    if (v === 0) group0.push(s);
    else group1.push(s);
  }

  const dummy = new THREE.Object3D();
  const baseColor = new THREE.Color();
  const outMeshes: THREE.InstancedMesh[] = [];
  const addColliders = options?.addColliders ?? true;
  const cBounds = options?.colliderBounds;
  const doCast = !isSoftwareGl && (options?.castShadow ?? true);
  const doRecv = !isSoftwareGl && (options?.receiveShadow ?? true);

  const buildBatch = (batch: BoulderSpot[], geo: THREE.BufferGeometry) => {
    if (batch.length === 0) return;
    const inst = new THREE.InstancedMesh(geo, matRock, batch.length);
    inst.castShadow = doCast;
    inst.receiveShadow = doRecv;

    for (let i = 0; i < batch.length; i++) {
      const r = batch[i];
      dummy.position.set(r.x, r.y + r.sy * 0.28, r.z);
      dummy.rotation.set(0, r.yaw, 0);
      dummy.scale.set(r.sx, r.sy, r.sz);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);

      if (r.tint) {
        inst.setColorAt(i, r.tint);
      } else {
        // Subtle natural granite/slate mineral variation per rock
        const vShade = 0.84 + ((i * 37) % 100) * 0.0028;
        const warmShift = ((i * 53) % 11) * 0.006 - 0.03;
        baseColor.setRGB(vShade + warmShift, vShade, vShade - warmShift * 0.7);
        inst.setColorAt(i, baseColor);
      }

      if (addColliders) {
        const inBounds =
          !cBounds ||
          (r.x >= cBounds.minX && r.x <= cBounds.maxX && r.z >= cBounds.minZ && r.z <= cBounds.maxZ);
        if (inBounds) {
          physics.addBox({
            minX: r.x - r.sx * 0.88,
            maxX: r.x + r.sx * 0.88,
            minY: r.y - r.sy * 0.5,
            maxY: r.y + r.sy * 0.84,
            minZ: r.z - r.sz * 0.88,
            maxZ: r.z + r.sz * 0.88,
            surface: 'concrete',
            blocksMovement: true,
            blocksRaycast: true,
            meshRef: inst,
          });
        }
      }
    }

    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.userData.surfaceMaterial = 'concrete';
    if (addColliders) {
      inst.userData.analyticalRaycastCovered = true;
    }
    sceneGroup.add(inst);
    raycastMeshes.push(inst);
    outMeshes.push(inst);
  };

  buildBatch(group0, cragGeo);
  buildBatch(group1, outcropGeo);
  return outMeshes;
}

/**
 * Builds a single organic scalloped conifer needle-whorl tier (replacing plain cones)
 * with radial branch-lobe undulations, downward tip droop, and baked interior shadow vertex-AO.
 */
function createScallopedPineWhorl(
  baseRadius: number,
  height: number,
  yBottom: number,
  lobes: number,
  phase: number,
  droopM: number,
  leanX: number,
  leanZ: number,
): THREE.BufferGeometry {
  const radialSegs = lobes * 2;
  const heightSegs = 3;
  const cone = new THREE.ConeGeometry(baseRadius, height, radialSegs, heightSegs, false);
  const geo = cone.index ? cone.toNonIndexed() : cone.clone();
  cone.dispose();

  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  const colors = new Float32Array(pos.count * 3);

  for (let i = 0; i < pos.count; i++) {
    const ox = pos.getX(i);
    const oy = pos.getY(i); // [-height/2 .. +height/2]
    const oz = pos.getZ(i);

    const hFrac = THREE.MathUtils.clamp((oy + height * 0.5) / height, 0, 1); // 0=bottom rim, 1=tip
    const ang = Math.atan2(oz, ox);
    const rad = Math.hypot(ox, oz);

    // Jagged scalloped branch lobes strongest near the lower rim, tapering smoothly toward the apex
    const rimWeight = Math.pow(1.0 - hFrac, 0.82);
    const lobeWave = Math.sin(ang * lobes + phase);
    const subWave = Math.cos(ang * (lobes * 2 - 1) - phase * 1.4);
    const radialScale = 1.0 + rimWeight * (lobeWave * 0.24 + subWave * 0.09);

    // Natural gravity-drooped bough tips on protruding branch lobes
    const tipDroop = rimWeight * (0.55 + 0.45 * lobeWave) * droopM;
    // Slight fuller belly curve so whorls read like layered boughs, not rigid triangles
    const bellyBow = Math.sin(hFrac * Math.PI) * 0.14 * baseRadius;

    const dirX = rad > 1e-5 ? ox / rad : 0;
    const dirZ = rad > 1e-5 ? oz / rad : 0;

    const nx = dirX * (rad * radialScale + bellyBow) + leanX * hFrac;
    const nz = dirZ * (rad * radialScale + bellyBow) + leanZ * hFrac;
    const ny = yBottom + (oy + height * 0.5) - tipDroop;

    pos.setXYZ(i, nx, ny, nz);
    uv.setXY(i, (ang / (Math.PI * 2) + 0.5) * 2.5, hFrac * 1.8);

    // Baked inner-crown AO: underside & recessed notches stay deep forest shadow; sunlit tips glow
    const lobeBright = 0.5 + 0.5 * lobeWave;
    const shade = THREE.MathUtils.clamp(
      0.56 + hFrac * 0.34 + lobeBright * rimWeight * 0.24 - (oy < -height * 0.48 ? 0.18 : 0),
      0.42,
      1.16,
    );
    colors[i * 3] = shade * 0.96;
    colors[i * 3 + 1] = shade * 1.04;
    colors[i * 3 + 2] = shade * 0.94;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

export interface PineTreeSpot {
  x: number;
  y: number;
  z: number;
  scale: number;
  yaw: number;
  tint: THREE.Color;
}

/**
 * Renders high-detail organic alpine pine/spruce trees using ONLY 2 InstancedMesh draw calls
 * for the entire forest (down from 3–4 separate cone meshes!):
 *  1) Fluted buttress-root trunk + lower deadwood branch stubs with furrowed pine bark + bump map
 *  2) 5-whorl asymmetrically drooped scalloped needle-bough canopy with baked interior AO + wind sway
 * Backed by fast analytical trunk AABB colliders (`analyticalRaycastCovered = true`).
 */
export function buildInstancedPineTrees(
  ctx: PropFactoryContext,
  spots: PineTreeSpot[],
  options?: {
    castShadow?: boolean;
    receiveShadow?: boolean;
    addTrunkColliders?: boolean;
    colliderBounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
    seed?: number;
  },
): { trunkInst: THREE.InstancedMesh; canopyInst: THREE.InstancedMesh } | null {
  if (spots.length === 0) return null;
  const { sceneGroup, physics, raycastMeshes, isSoftwareGl, trackGeo, trackMat, trackTex, windUniforms, maxAniso } =
    ctx;
  const regTex = <T extends THREE.Texture>(t: T): T => (trackTex ? trackTex(t) : t);

  const barkTex = createPineBarkTextureSet(maxAniso ?? 4, options?.seed ?? 5502);
  const needleTex = createPineNeedleTexture(maxAniso ?? 4, (options?.seed ?? 5502) + 7);
  regTex(barkTex.map);
  regTex(barkTex.bumpMap);
  regTex(needleTex);

  const matBark = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: barkTex.map,
      bumpMap: barkTex.bumpMap,
      bumpScale: 0.06,
      roughness: 0.94,
      metalness: 0.02,
      vertexColors: true,
    }),
  );
  const matNeedles = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: needleTex,
      roughness: 0.87,
      metalness: 0.01,
      vertexColors: true,
    }),
  );

  if (windUniforms) {
    applyWindFoliageShader(matBark, windUniforms, { swayScale: 0.06, isTrunk: true });
    applyWindFoliageShader(matNeedles, windUniforms, { swayScale: 0.21 });
  }

  // 1. Sculpted trunk with fluted root flare + subtle organic curve + 4 lower deadwood branch stubs
  const mainTrunk = new THREE.CylinderGeometry(0.11, 0.34, 7.6, 8, 5);
  mainTrunk.translate(0, 3.8, 0);
  {
    const pos = mainTrunk.getAttribute('position');
    const cols = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      let vx = pos.getX(i);
      const vy = pos.getY(i);
      let vz = pos.getZ(i);
      const hFrac = THREE.MathUtils.clamp(vy / 7.6, 0, 1);
      const ang = Math.atan2(vz, vx);
      // Fluted buttress roots near base (y < 1.4m)
      const rootFactor = Math.max(0, 1.0 - vy / 1.45);
      const flute = 1.0 + rootFactor * rootFactor * (0.34 + 0.28 * Math.cos(ang * 5.0));
      vx = vx * flute + Math.sin(hFrac * Math.PI) * 0.08;
      vz = vz * flute + Math.cos(hFrac * Math.PI * 0.8) * 0.05;
      pos.setXYZ(i, vx, vy, vz);
      const shade = 0.72 + hFrac * 0.3;
      cols[i * 3] = shade;
      cols[i * 3 + 1] = shade;
      cols[i * 3 + 2] = shade;
    }
    mainTrunk.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    mainTrunk.computeVertexNormals();
  }

  const trunkParts: THREE.BufferGeometry[] = [mainTrunk];
  const stubDefs = [
    { y: 1.85, ang: 0.4, len: 0.78, tilt: 1.15 },
    { y: 2.35, ang: 2.35, len: 0.92, tilt: 1.22 },
    { y: 2.85, ang: 4.15, len: 0.84, tilt: 1.18 },
    { y: 3.3, ang: 5.4, len: 0.72, tilt: 1.12 },
  ];
  for (const st of stubDefs) {
    const stub = new THREE.CylinderGeometry(0.025, 0.068, st.len, 5, 1);
    stub.translate(0, st.len * 0.5, 0);
    stub.rotateZ(-st.tilt);
    stub.rotateY(st.ang);
    stub.translate(0, st.y, 0);
    trunkParts.push(stub);
  }
  const trunkGeo = trackGeo(mergePartsToSingleGeometry(trunkParts, true, true));
  assignHeightSwayAttribute(trunkGeo, 0, 7.6, 2.0);

  // 2. Merged 5-whorl asymmetrically drooped scalloped pine canopy (1 draw call for all foliage!)
  const whorlParts = [
    createScallopedPineWhorl(2.55, 3.15, 2.35, 7, 0.3, 0.42, 0.06, -0.04),
    createScallopedPineWhorl(2.18, 3.05, 4.15, 7, 1.45, 0.36, -0.05, 0.07),
    createScallopedPineWhorl(1.78, 2.85, 5.85, 6, 2.6, 0.3, 0.05, 0.05),
    createScallopedPineWhorl(1.32, 2.55, 7.45, 6, 0.85, 0.22, -0.04, -0.03),
    createScallopedPineWhorl(0.84, 2.25, 8.85, 5, 2.1, 0.14, 0.02, 0.02),
  ];
  const canopyGeo = trackGeo(mergePartsToSingleGeometry(whorlParts, true, true));
  assignHeightSwayAttribute(canopyGeo, 1.8, 11.2, 1.65);

  const trunkInst = new THREE.InstancedMesh(trunkGeo, matBark, spots.length);
  const canopyInst = new THREE.InstancedMesh(canopyGeo, matNeedles, spots.length);

  const doCast = !isSoftwareGl && (options?.castShadow ?? true);
  const doRecv = !isSoftwareGl && (options?.receiveShadow ?? true);
  trunkInst.castShadow = doCast;
  trunkInst.receiveShadow = doRecv;
  canopyInst.castShadow = doCast;
  canopyInst.receiveShadow = doRecv;

  const dummy = new THREE.Object3D();
  const addColliders = options?.addTrunkColliders ?? true;
  const cBounds = options?.colliderBounds;

  for (let i = 0; i < spots.length; i++) {
    const t = spots[i];
    const hVar = 0.88 + ((i * 29) % 100) * 0.0028;
    dummy.position.set(t.x, t.y - 0.16, t.z);
    dummy.rotation.set(((i % 5) - 2) * 0.016, t.yaw, (((i * 3) % 5) - 2) * 0.016);
    dummy.scale.set(t.scale, t.scale * hVar, t.scale);
    dummy.updateMatrix();
    trunkInst.setMatrixAt(i, dummy.matrix);
    canopyInst.setMatrixAt(i, dummy.matrix);
    canopyInst.setColorAt(i, t.tint);

    if (addColliders) {
      const inBounds =
        !cBounds ||
        (t.x >= cBounds.minX && t.x <= cBounds.maxX && t.z >= cBounds.minZ && t.z <= cBounds.maxZ);
      if (inBounds) {
        const r = 0.34 * t.scale;
        physics.addBox({
          minX: t.x - r,
          maxX: t.x + r,
          minY: t.y - 0.2,
          maxY: t.y + 4.4 * t.scale,
          minZ: t.z - r,
          maxZ: t.z + r,
          surface: 'wood',
          blocksMovement: true,
          blocksRaycast: true,
          meshRef: trunkInst,
        });
      }
    }
  }

  for (const inst of [trunkInst, canopyInst]) {
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.userData.surfaceMaterial = 'wood';
    sceneGroup.add(inst);
  }
  if (addColliders) {
    trunkInst.userData.analyticalRaycastCovered = true;
  }
  raycastMeshes.push(trunkInst);

  return { trunkInst, canopyInst };
}

/**
 * Instanced high-detail overgrown birch trees (peeling white bark with dark horizontal lenticels,
 * flared root base, 3 forked upper limbs, and botanical multi-lobe leaf-spray crown in 2 draw calls total).
 */
export function buildInstancedBirchTrees(
  ctx: PropFactoryContext,
  spots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }>,
  addTrunkColliders = false,
): void {
  if (spots.length === 0) return;
  const { sceneGroup, physics, raycastMeshes, isSoftwareGl, trackGeo, trackMat, trackTex, windUniforms, maxAniso } =
    ctx;
  const regTex = <T extends THREE.Texture>(t: T): T => (trackTex ? trackTex(t) : t);

  const barkTex = createBirchBarkTextureSet(maxAniso ?? 4, 5610);
  const leafTex = createBirchLeafClusterTexture(maxAniso ?? 4, 5624);
  regTex(barkTex.map);
  regTex(barkTex.bumpMap);
  regTex(leafTex);

  const matBirchBark = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: barkTex.map,
      bumpMap: barkTex.bumpMap,
      bumpScale: 0.04,
      roughness: 0.88,
      metalness: 0.02,
    }),
  );
  const matFoliage = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: leafTex,
      alphaTest: 0.36,
      roughness: 0.84,
      metalness: 0.01,
      side: THREE.DoubleSide,
      vertexColors: true,
    }),
  );
  if (windUniforms) {
    applyWindFoliageShader(matBirchBark, windUniforms, { swayScale: 0.08, isTrunk: true });
    applyWindFoliageShader(matFoliage, windUniforms, { swayScale: 0.24 });
  }

  // 1. Flared slightly bowed birch trunk + 3 ascending upper forked limbs merged into 1 geometry
  const mainStem = new THREE.CylinderGeometry(0.085, 0.21, 4.6, 8, 4);
  mainStem.translate(0, 2.3, 0);
  {
    const pos = mainStem.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const vy = pos.getY(i);
      const t = vy / 4.6;
      const rootFlare = vy < 0.9 ? 1.0 + (1.0 - vy / 0.9) * 0.28 : 1.0;
      pos.setX(i, pos.getX(i) * rootFlare + Math.sin(t * Math.PI) * 0.14);
      pos.setZ(i, pos.getZ(i) * rootFlare + Math.cos(t * Math.PI * 0.7) * 0.06);
    }
    mainStem.computeVertexNormals();
  }

  const limb1 = new THREE.CylinderGeometry(0.035, 0.075, 2.45, 6, 2);
  limb1.translate(0, 1.22, 0);
  limb1.rotateZ(0.42);
  limb1.rotateY(0.5);
  limb1.translate(0.08, 3.65, 0.04);

  const limb2 = new THREE.CylinderGeometry(0.032, 0.068, 2.3, 6, 2);
  limb2.translate(0, 1.15, 0);
  limb2.rotateZ(-0.48);
  limb2.rotateY(2.4);
  limb2.translate(-0.04, 3.85, -0.05);

  const limb3 = new THREE.CylinderGeometry(0.028, 0.062, 2.0, 6, 2);
  limb3.translate(0, 1.0, 0);
  limb3.rotateZ(0.36);
  limb3.rotateY(4.5);
  limb3.translate(0.02, 4.15, 0.02);

  const trunkGeo = trackGeo(mergePartsToSingleGeometry([mainStem, limb1, limb2, limb3], false, true));
  assignHeightSwayAttribute(trunkGeo, 0, 6.2, 2.0);

  // 2. Botanical multi-lobe leaf-spray crown (18 crossed angled leaf-cluster cards merged into 1 draw call!)
  const crownCards: THREE.BufferGeometry[] = [];
  const clusterAnchors: Array<[number, number, number, number, number]> = [
    [0.0, 5.4, 0.0, 2.35, 0.92],
    [-0.95, 5.05, 0.55, 1.85, 0.88],
    [0.98, 5.25, -0.45, 1.9, 0.96],
    [0.35, 6.35, 0.25, 1.75, 1.06],
    [-0.55, 6.1, -0.6, 1.65, 1.02],
    [0.05, 4.45, -0.75, 1.55, 0.78],
  ];

  for (let c = 0; c < clusterAnchors.length; c++) {
    const [cx, cy, cz, sz, bright] = clusterAnchors[c];
    for (let k = 0; k < 3; k++) {
      const card = new THREE.PlaneGeometry(sz, sz * 0.94, 1, 1);
      const tilt = (k - 1) * 0.34;
      const yaw = (k / 3) * Math.PI + c * 0.65;
      card.rotateX(tilt);
      card.rotateY(yaw);
      card.translate(cx, cy, cz);

      const pAttr = card.getAttribute('position');
      const cols = new Float32Array(pAttr.count * 3);
      for (let v = 0; v < pAttr.count; v++) {
        const vy = pAttr.getY(v);
        const ao = THREE.MathUtils.clamp(bright * (0.74 + ((vy - 3.8) / 3.6) * 0.36), 0.58, 1.15);
        cols[v * 3] = ao;
        cols[v * 3 + 1] = ao;
        cols[v * 3 + 2] = ao;
      }
      card.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      crownCards.push(card);
    }
  }

  const crownGeo = trackGeo(mergePartsToSingleGeometry(crownCards, true, true));
  assignHeightSwayAttribute(crownGeo, 1.8, 7.6, 1.55);

  const trunkInst = new THREE.InstancedMesh(trunkGeo, matBirchBark, spots.length);
  const crownInst = new THREE.InstancedMesh(crownGeo, matFoliage, spots.length);

  trunkInst.castShadow = !isSoftwareGl;
  trunkInst.receiveShadow = !isSoftwareGl;
  crownInst.castShadow = !isSoftwareGl;

  const dummy = new THREE.Object3D();
  spots.forEach((s, i) => {
    dummy.position.set(s.x, s.y - 0.08, s.z);
    dummy.rotation.set(((i % 3) - 1) * 0.025, s.yaw, (((i * 2) % 3) - 1) * 0.02);
    dummy.scale.set(s.scale, s.scale * (0.92 + (i % 3) * 0.12), s.scale);
    dummy.updateMatrix();
    trunkInst.setMatrixAt(i, dummy.matrix);
    crownInst.setMatrixAt(i, dummy.matrix);
    crownInst.setColorAt(i, s.tint);

    if (addTrunkColliders) {
      const r = 0.25 * s.scale;
      physics.addBox({
        minX: s.x - r,
        maxX: s.x + r,
        minY: s.y - 0.1,
        maxY: s.y + 3.8 * s.scale,
        minZ: s.z - r,
        maxZ: s.z + r,
        surface: 'wood',
        blocksMovement: true,
        blocksRaycast: true,
        meshRef: trunkInst,
      });
    }
  });

  for (const inst of [trunkInst, crownInst]) {
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.userData.surfaceMaterial = 'wood';
    sceneGroup.add(inst);
  }
  if (addTrunkColliders) {
    trunkInst.userData.analyticalRaycastCovered = true;
  }
  raycastMeshes.push(trunkInst);
}

/** Builds a merged multi-card botanical geometry tilted & bowed naturally */
function createRosetteCardGeometry(
  trackGeo: TrackGeoFn,
  cardCount: number,
  width: number,
  height: number,
  tiltRad: number,
  archPower: number,
): THREE.BufferGeometry {
  const planes: THREE.BufferGeometry[] = [];
  for (let c = 0; c < cardCount; c++) {
    const p = new THREE.PlaneGeometry(width, height, 1, 4);
    p.translate(0, height * 0.5, 0);
    const pos = p.getAttribute('position');
    for (let v = 0; v < pos.count; v++) {
      const y = pos.getY(v);
      const t = Math.max(0, Math.min(1, y / height));
      // Subtle outward arch along Z so blades drape gracefully
      pos.setZ(v, Math.pow(t, archPower) * height * 0.28);
      if (tiltRad !== 0) {
        const yRot = y * Math.cos(tiltRad) - pos.getZ(v) * Math.sin(tiltRad);
        const zRot = y * Math.sin(tiltRad) + pos.getZ(v) * Math.cos(tiltRad);
        pos.setY(v, yRot);
        pos.setZ(v, zRot);
      }
    }
    p.rotateY((c / cardCount) * Math.PI);
    p.computeVertexNormals();
    planes.push(p);
  }

  // Merge cards cleanly into a single non-indexed BufferGeometry
  let totalVerts = 0;
  const nonIndexed = planes.map((p) => {
    const g = p.index ? p.toNonIndexed() : p.clone();
    p.dispose();
    totalVerts += g.getAttribute('position').count;
    return g;
  });

  const mergedPos = new Float32Array(totalVerts * 3);
  const mergedNorm = new Float32Array(totalVerts * 3);
  const mergedUv = new Float32Array(totalVerts * 2);
  const mergedSway = new Float32Array(totalVerts);

  let offset3 = 0;
  let offset2 = 0;
  let offset1 = 0;
  for (const g of nonIndexed) {
    const pos = g.getAttribute('position');
    const norm = g.getAttribute('normal');
    const uv = g.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const x = pos.getX(i);
      const z = pos.getZ(i);
      mergedPos[offset3] = x;
      mergedPos[offset3 + 1] = y;
      mergedPos[offset3 + 2] = z;
      mergedNorm[offset3] = norm.getX(i);
      mergedNorm[offset3 + 1] = norm.getY(i);
      mergedNorm[offset3 + 2] = norm.getZ(i);
      mergedUv[offset2] = uv.getX(i);
      mergedUv[offset2 + 1] = uv.getY(i);
      const t = Math.max(0, Math.min(1, y / Math.max(0.05, height)));
      mergedSway[offset1] = Math.pow(t, 1.55);
      offset3 += 3;
      offset2 += 2;
      offset1 += 1;
    }
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(mergedPos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(mergedNorm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(mergedUv, 2));
  out.setAttribute('aSway', new THREE.BufferAttribute(mergedSway, 1));
  out.computeBoundingSphere();
  return trackGeo(out);
}

/** Instanced curved botanical meadow grass blade clusters with wind-coupled GPU sway */
export function buildInstancedGrassTufts(
  ctx: PropFactoryContext,
  spots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }>,
): void {
  if (spots.length === 0) return;
  const { sceneGroup, trackGeo, trackMat, windUniforms, maxAniso } = ctx;

  const tex = createGrassClumpTexture(maxAniso ?? 4);
  const matGrass = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: tex,
      alphaTest: 0.36,
      roughness: 0.88,
      metalness: 0.01,
      side: THREE.DoubleSide,
    }),
  );
  if (windUniforms) {
    applyWindFoliageShader(matGrass, windUniforms, { swayScale: 0.38 });
  }

  const clumpGeo = createRosetteCardGeometry(trackGeo, 3, 0.72, 0.56, 0.08, 1.85);
  const inst = new THREE.InstancedMesh(clumpGeo, matGrass, spots.length);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    dummy.position.set(s.x, s.y - 0.02, s.z);
    dummy.rotation.set(0, s.yaw, 0);
    dummy.scale.set(s.scale, s.scale * (0.85 + (i % 4) * 0.11), s.scale);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
    inst.setColorAt(i, s.tint);
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.computeBoundingSphere();
  inst.userData.surfaceMaterial = 'grass';
  sceneGroup.add(inst);
}

/** Instanced forest fern rosettes with arched pinnate fronds & wind-coupled GPU sway */
export function buildInstancedFerns(
  ctx: PropFactoryContext,
  spots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }>,
): void {
  if (spots.length === 0) return;
  const { sceneGroup, trackGeo, trackMat, windUniforms, maxAniso } = ctx;

  const tex = createFernFrondTexture(maxAniso ?? 4);
  const matFern = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: tex,
      alphaTest: 0.36,
      roughness: 0.82,
      metalness: 0.02,
      side: THREE.DoubleSide,
    }),
  );
  if (windUniforms) {
    applyWindFoliageShader(matFern, windUniforms, { swayScale: 0.28 });
  }

  const fernGeo = createRosetteCardGeometry(trackGeo, 4, 0.92, 0.76, 0.56, 1.45);
  const inst = new THREE.InstancedMesh(fernGeo, matFern, spots.length);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    dummy.position.set(s.x, s.y - 0.03, s.z);
    dummy.rotation.set(0, s.yaw, 0);
    dummy.scale.set(s.scale, s.scale * (0.9 + (i % 3) * 0.09), s.scale);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
    inst.setColorAt(i, s.tint);
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.computeBoundingSphere();
  inst.userData.surfaceMaterial = 'grass';
  sceneGroup.add(inst);
}

/** Instanced woody leafy undergrowth shrubs with wind-coupled GPU sway */
export function buildInstancedUndergrowthShrubs(
  ctx: PropFactoryContext,
  spots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }>,
): void {
  if (spots.length === 0) return;
  const { sceneGroup, trackGeo, trackMat, windUniforms, maxAniso } = ctx;

  const tex = createShrubBranchTexture(maxAniso ?? 4);
  const matShrub = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: tex,
      alphaTest: 0.36,
      roughness: 0.86,
      metalness: 0.02,
      side: THREE.DoubleSide,
    }),
  );
  if (windUniforms) {
    applyWindFoliageShader(matShrub, windUniforms, { swayScale: 0.24 });
  }

  const shrubGeo = createRosetteCardGeometry(trackGeo, 3, 1.28, 1.12, 0.16, 1.6);
  const inst = new THREE.InstancedMesh(shrubGeo, matShrub, spots.length);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    dummy.position.set(s.x, s.y - 0.04, s.z);
    dummy.rotation.set(0, s.yaw, 0);
    dummy.scale.set(s.scale, s.scale * (0.88 + (i % 3) * 0.14), s.scale);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
    inst.setColorAt(i, s.tint);
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.computeBoundingSphere();
  inst.userData.surfaceMaterial = 'grass';
  sceneGroup.add(inst);
}


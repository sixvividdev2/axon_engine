import * as THREE from 'three';
import { BodycamPhysicsWorld } from '../bodycam-sdk';

export type TrackGeoFn = <T extends THREE.BufferGeometry>(g: T) => T;
export type TrackMatFn = <T extends THREE.Material>(m: T) => T;

export interface PropFactoryContext {
  sceneGroup: THREE.Group;
  physics: BodycamPhysicsWorld;
  raycastMeshes: THREE.Object3D[];
  isSoftwareGl: boolean;
  trackGeo: TrackGeoFn;
  trackMat: TrackMatFn;
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

/** Instanced overgrown birch trees & saplings (distinctive white-bark Exclusion Zone trees) */
export function buildInstancedBirchTrees(
  ctx: PropFactoryContext,
  spots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }>,
  addTrunkColliders = false,
): void {
  if (spots.length === 0) return;
  const { sceneGroup, physics, raycastMeshes, isSoftwareGl, trackGeo, trackMat } = ctx;

  const matBirchBark = trackMat(new THREE.MeshStandardMaterial({ color: 0xc9c6bc, roughness: 0.9, metalness: 0.02 }));
  const matFoliage = trackMat(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86, metalness: 0.02 }));

  const trunkGeo = trackGeo(new THREE.CylinderGeometry(0.09, 0.17, 4.6, 7));
  trunkGeo.translate(0, 2.3, 0);
  const crown1Geo = trackGeo(new THREE.DodecahedronGeometry(1.55, 1));
  crown1Geo.translate(0, 5.1, 0);
  const crown2Geo = trackGeo(new THREE.DodecahedronGeometry(1.18, 1));
  crown2Geo.translate(0.55, 6.25, -0.35);

  const trunkInst = new THREE.InstancedMesh(trunkGeo, matBirchBark, spots.length);
  const crown1Inst = new THREE.InstancedMesh(crown1Geo, matFoliage, spots.length);
  const crown2Inst = new THREE.InstancedMesh(crown2Geo, matFoliage, spots.length);

  trunkInst.castShadow = !isSoftwareGl;
  crown1Inst.castShadow = !isSoftwareGl;

  const dummy = new THREE.Object3D();
  spots.forEach((s, i) => {
    dummy.position.set(s.x, s.y - 0.05, s.z);
    dummy.rotation.set(0, s.yaw, 0);
    dummy.scale.set(s.scale, s.scale * (0.92 + (i % 3) * 0.12), s.scale);
    dummy.updateMatrix();
    trunkInst.setMatrixAt(i, dummy.matrix);
    crown1Inst.setMatrixAt(i, dummy.matrix);
    crown2Inst.setMatrixAt(i, dummy.matrix);

    crown1Inst.setColorAt(i, s.tint);
    crown2Inst.setColorAt(i, s.tint.clone().offsetHSL(0.01, 0, 0.04));

    if (addTrunkColliders) {
      const r = 0.24 * s.scale;
      physics.addBox({
        minX: s.x - r,
        maxX: s.x + r,
        minY: s.y,
        maxY: s.y + 3.6,
        minZ: s.z - r,
        maxZ: s.z + r,
        surface: 'wood',
        blocksMovement: true,
      });
    }
  });

  for (const inst of [trunkInst, crown1Inst, crown2Inst]) {
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.computeBoundingSphere();
    inst.userData.surfaceMaterial = 'wood';
    sceneGroup.add(inst);
  }
  raycastMeshes.push(trunkInst);
}

/** Instanced crossed grass / weed tufts for overgrown asphalt cracks and forest undergrowth */
export function buildInstancedGrassTufts(
  ctx: PropFactoryContext,
  spots: Array<{ x: number; y: number; z: number; scale: number; yaw: number; tint: THREE.Color }>,
): void {
  if (spots.length === 0) return;
  const { sceneGroup, trackGeo, trackMat } = ctx;

  const matGrass = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.92,
      metalness: 0.01,
      side: THREE.DoubleSide,
    }),
  );

  // Two crossed vertical diamond blades merged cleanly into one InstancedMesh draw call
  const bladeGeo = trackGeo(new THREE.ConeGeometry(0.18, 0.56, 3));
  bladeGeo.translate(0, 0.28, 0);

  const inst = new THREE.InstancedMesh(bladeGeo, matGrass, spots.length * 2);
  const dummy = new THREE.Object3D();
  let idx = 0;
  for (const s of spots) {
    for (let k = 0; k < 2; k++) {
      dummy.position.set(s.x + (k === 0 ? -0.07 : 0.07), s.y, s.z + (k === 0 ? 0.05 : -0.05));
      dummy.rotation.set(k === 0 ? 0.14 : -0.12, s.yaw + k * 1.1, k === 0 ? -0.1 : 0.12);
      dummy.scale.set(s.scale, s.scale * (0.85 + k * 0.25), s.scale);
      dummy.updateMatrix();
      inst.setMatrixAt(idx, dummy.matrix);
      inst.setColorAt(idx, k === 0 ? s.tint : s.tint.clone().offsetHSL(0.02, 0, -0.03));
      idx++;
    }
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  inst.computeBoundingSphere();
  sceneGroup.add(inst);
}

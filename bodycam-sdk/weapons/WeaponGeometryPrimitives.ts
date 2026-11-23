import * as THREE from 'three';
import { WeaponPBRMaterialLibrary } from './WeaponMaterials';

export type GeoTracker = <T extends THREE.BufferGeometry>(g: T) => T;

export interface BeveledBoxOptions {
  width: number;
  height: number;
  depth: number;
  bevel?: number;
  bevelSegments?: number;
}

/**
 * Centered beveled box using ExtrudeGeometry along Z (front-to-back) so receivers,
 * slides, stocks, and shrouds catch realistic specular edge highlights.
 */
export function buildBeveledBox(
  track: GeoTracker,
  width: number,
  height: number,
  depth: number,
  bevel = 0.0014,
  bevelSegments = 2,
): THREE.BufferGeometry {
  const b = Math.min(bevel, width * 0.24, height * 0.24, depth * 0.24);
  const hw = Math.max(0.0005, width * 0.5 - b);
  const hh = Math.max(0.0005, height * 0.5 - b);
  const innerDepth = Math.max(0.0005, depth - b * 2);

  const shape = new THREE.Shape();
  shape.moveTo(-hw, -hh);
  shape.lineTo(hw, -hh);
  shape.lineTo(hw, hh);
  shape.lineTo(-hw, hh);
  shape.closePath();

  const geo = track(
    new THREE.ExtrudeGeometry(shape, {
      depth: innerDepth,
      bevelEnabled: b > 0.0002,
      bevelThickness: b,
      bevelSize: b,
      bevelSegments,
      curveSegments: 2,
    }),
  );
  geo.translate(0, 0, -innerDepth * 0.5);
  return geo;
}

/**
 * Builds a hollow chamfered barrel along -Z with a dark recessed bore cavity at the muzzle crown.
 */
export function buildHollowBarrel(
  track: GeoTracker,
  mats: WeaponPBRMaterialLibrary,
  opts: {
    outerRadiusFront: number;
    outerRadiusRear?: number;
    length: number;
    boreRadius?: number;
    material: THREE.Material;
    radialSegments?: number;
    includeThreads?: boolean;
    includeFlashHider?: boolean;
    flashHiderLength?: number;
  },
): THREE.Group {
  const g = new THREE.Group();
  const rFront = opts.outerRadiusFront;
  const rRear = opts.outerRadiusRear ?? rFront * 1.08;
  const segs = opts.radialSegments ?? 14;
  const boreR = Math.min(rFront * 0.72, opts.boreRadius ?? rFront * 0.54);

  const outer = new THREE.Mesh(
    track(new THREE.CylinderGeometry(rFront, rRear, opts.length, segs)),
    opts.material,
  );
  outer.rotation.x = Math.PI * 0.5;
  g.add(outer);

  const crownZ = -opts.length * 0.5;
  // Chamfered muzzle crown ring
  const crownRing = new THREE.Mesh(
    track(new THREE.TorusGeometry((rFront + boreR) * 0.5, Math.max(0.0008, (rFront - boreR) * 0.48), 6, segs)),
    opts.material,
  );
  crownRing.position.z = crownZ + 0.0006;
  g.add(crownRing);

  // Dark recessed bore cavity (recessed 1.5mm inside crown)
  const boreWall = new THREE.Mesh(
    track(new THREE.CylinderGeometry(boreR, boreR * 0.96, 0.018, 12, 1, true)),
    mats.recessedCavity,
  );
  boreWall.rotation.x = Math.PI * 0.5;
  boreWall.position.z = crownZ + 0.009;
  const boreCap = new THREE.Mesh(
    track(new THREE.CircleGeometry(boreR * 0.99, 12)),
    mats.recessedCavity,
  );
  boreCap.rotation.y = Math.PI;
  boreCap.position.z = crownZ + 0.0012;
  g.add(boreWall, boreCap);

  if (opts.includeThreads) {
    const threadCollar = new THREE.Mesh(
      track(new THREE.CylinderGeometry(rFront * 0.92, rFront * 0.92, 0.011, 12)),
      mats.anodized,
    );
    threadCollar.rotation.x = Math.PI * 0.5;
    threadCollar.position.z = crownZ + 0.006;
    g.add(threadCollar);
  }

  if (opts.includeFlashHider) {
    const fhLen = opts.flashHiderLength ?? 0.042;
    const fhR = Math.max(rFront + 0.0022, 0.0112);
    const fhInner = Math.max(boreR + 0.0012, fhR * 0.62);
    const fhBody = new THREE.Mesh(
      track(new THREE.CylinderGeometry(fhR, fhR * 0.98, fhLen, 12)),
      mats.anodized,
    );
    fhBody.rotation.x = Math.PI * 0.5;
    fhBody.position.z = crownZ - fhLen * 0.42;
    const fhBore = new THREE.Mesh(
      track(new THREE.CircleGeometry(fhInner, 12)),
      mats.recessedCavity,
    );
    fhBore.rotation.y = Math.PI;
    fhBore.position.z = crownZ - fhLen * 0.92 - 0.0004;
    // Flash hider side port recesses
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
      const port = new THREE.Mesh(
        track(new THREE.BoxGeometry(0.0032, 0.0032, fhLen * 0.46)),
        mats.recessedCavity,
      );
      port.position.set(
        Math.cos(a) * (fhR - 0.0008),
        Math.sin(a) * (fhR - 0.0008),
        crownZ - fhLen * 0.52,
      );
      port.rotation.z = a;
      g.add(port);
    }
    g.add(fhBody, fhBore);
  }

  return g;
}

/**
 * Adds a recessed dark bore cavity ring onto any suppressor or muzzle device tip at z = tipZ (facing -Z).
 */
export function buildMuzzleBoreCap(
  track: GeoTracker,
  mats: WeaponPBRMaterialLibrary,
  outerRadius: number,
  boreRadius: number,
  tipZ: number,
  capMaterial: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();
  const crown = new THREE.Mesh(
    track(
      new THREE.TorusGeometry(
        (outerRadius + boreRadius) * 0.5,
        Math.max(0.001, (outerRadius - boreRadius) * 0.44),
        6,
        16,
      ),
    ),
    capMaterial,
  );
  crown.position.z = tipZ + 0.0005;
  const bore = new THREE.Mesh(
    track(new THREE.CircleGeometry(boreRadius, 14)),
    mats.recessedCavity,
  );
  bore.rotation.y = Math.PI;
  bore.position.z = tipZ - 0.0006;
  g.add(crown, bore);
  return g;
}

export interface GripAssemblyResult {
  group: THREE.Group;
  widthM: number;
  depthM: number;
  rakeRad: number;
}

/**
 * Builds a properly rearward-raked firearm grip (rotation.x = -rakeRad so downward -Y
 * pitches cleanly rearward toward +Z toward the shooter's palm/wrist).
 */
export function buildGripAssembly(
  track: GeoTracker,
  mats: WeaponPBRMaterialLibrary,
  opts: {
    width: number;
    height: number;
    depth: number;
    rakeRad: number;
    pos: [number, number, number];
    coreMat: THREE.Material;
    panelMat?: THREE.Material;
    includeBackstrapSwell?: boolean;
    includeMagwellFlare?: boolean;
  },
): GripAssemblyResult {
  const g = new THREE.Group();
  g.position.set(...opts.pos);
  // CRITICAL: Negative rotation.x pitches the downward -Y grip axis rearward toward +Z!
  g.rotation.x = -Math.abs(opts.rakeRad);

  const core = new THREE.Mesh(
    buildBeveledBox(track, opts.width, opts.height, opts.depth, 0.0022, 2),
    opts.coreMat,
  );
  g.add(core);

  if (opts.panelMat) {
    const panelH = opts.height * 0.78;
    const panelD = opts.depth * 0.74;
    const panelGeo = buildBeveledBox(track, 0.0034, panelH, panelD, 0.0009, 1);
    const panelL = new THREE.Mesh(panelGeo, opts.panelMat);
    panelL.position.set(-opts.width * 0.5 - 0.0004, 0.001, 0.001);
    const panelR = new THREE.Mesh(panelGeo, opts.panelMat);
    panelR.position.set(opts.width * 0.5 + 0.0004, 0.001, 0.001);
    g.add(panelL, panelR);
  }

  if (opts.includeBackstrapSwell) {
    const swell = new THREE.Mesh(
      buildBeveledBox(track, opts.width * 0.86, opts.height * 0.44, 0.006, 0.0016, 1),
      opts.panelMat ?? mats.checkeredGrip,
    );
    swell.position.set(0, -opts.height * 0.14, opts.depth * 0.48);
    g.add(swell);
  }

  if (opts.includeMagwellFlare) {
    const flare = new THREE.Mesh(
      buildBeveledBox(track, opts.width + 0.004, 0.007, opts.depth + 0.005, 0.0012, 1),
      opts.coreMat,
    );
    flare.position.set(0, -opts.height * 0.48, 0.001);
    g.add(flare);
  }

  return {
    group: g,
    widthM: opts.width + (opts.panelMat ? 0.004 : 0),
    depthM: opts.depth + (opts.includeBackstrapSwell ? 0.004 : 0),
    rakeRad: Math.abs(opts.rakeRad),
  };
}

/**
 * Builds an authentic open-loop trigger guard with a curved internal trigger shoe.
 */
export function buildTriggerAndGuard(
  track: GeoTracker,
  mats: WeaponPBRMaterialLibrary,
  opts: {
    y: number;
    z: number;
    guardW?: number;
    guardMat?: THREE.Material;
    triggerMat?: THREE.Material;
  },
): { guardGroup: THREE.Group; triggerPivot: THREE.Group } {
  const guardW = opts.guardW ?? 0.0135;
  const guardMat = opts.guardMat ?? mats.anodized;
  const triggerMat = opts.triggerMat ?? mats.gunmetal;

  const guardGroup = new THREE.Group();
  // Bottom bow
  const bottomBow = new THREE.Mesh(
    buildBeveledBox(track, guardW, 0.0038, 0.048, 0.0008, 1),
    guardMat,
  );
  bottomBow.position.set(0, opts.y - 0.020, opts.z - 0.004);
  // Front strut angled slightly forward
  const frontStrut = new THREE.Mesh(
    buildBeveledBox(track, guardW, 0.023, 0.0042, 0.0008, 1),
    guardMat,
  );
  frontStrut.position.set(0, opts.y - 0.009, opts.z - 0.027);
  frontStrut.rotation.x = 0.16;
  // Rear strut joining grip tang
  const rearStrut = new THREE.Mesh(
    buildBeveledBox(track, guardW, 0.014, 0.0042, 0.0008, 1),
    guardMat,
  );
  rearStrut.position.set(0, opts.y - 0.014, opts.z + 0.019);
  rearStrut.rotation.x = -0.22;
  guardGroup.add(bottomBow, frontStrut, rearStrut);

  // Curved internal trigger shoe pivoted cleanly at upper sear pin
  const triggerPivot = new THREE.Group();
  triggerPivot.position.set(0, opts.y, opts.z);
  const upperShoe = new THREE.Mesh(
    buildBeveledBox(track, 0.0044, 0.011, 0.0046, 0.0007, 1),
    triggerMat,
  );
  upperShoe.position.set(0, -0.0055, -0.0015);
  upperShoe.rotation.x = 0.16;
  const lowerShoe = new THREE.Mesh(
    buildBeveledBox(track, 0.0044, 0.010, 0.0044, 0.0007, 1),
    triggerMat,
  );
  lowerShoe.position.set(0, -0.0135, -0.0036);
  lowerShoe.rotation.x = -0.34;
  triggerPivot.add(upperShoe, lowerShoe);

  return { guardGroup, triggerPivot };
}

/**
 * Builds a single 12-gauge shotgun shell (brass head + crimped red polymer hull)
 * for tubular reload hand-feeding animations.
 */
export function buildShotgunShellMesh(
  track: GeoTracker,
  mats: WeaponPBRMaterialLibrary,
  heavyBore = false,
): THREE.Group {
  const g = new THREE.Group();
  const r = heavyBore ? 0.0112 : 0.0092;
  const hull = new THREE.Mesh(
    track(new THREE.CylinderGeometry(r, r, 0.044, 12)),
    mats.redShell,
  );
  hull.rotation.x = Math.PI * 0.5;
  hull.position.z = -0.008;

  const brassHead = new THREE.Mesh(
    track(new THREE.CylinderGeometry(r * 1.03, r * 1.05, 0.015, 12)),
    mats.brass,
  );
  brassHead.rotation.x = Math.PI * 0.5;
  brassHead.position.z = 0.020;

  const rim = new THREE.Mesh(
    track(new THREE.CylinderGeometry(r * 1.12, r * 1.12, 0.0024, 12)),
    mats.brass,
  );
  rim.rotation.x = Math.PI * 0.5;
  rim.position.z = 0.028;

  g.add(hull, brassHead, rim);
  return g;
}

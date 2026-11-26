import * as THREE from 'three';
import {
  operatorAssetLoader,
  resolveWeaponProfile,
  WeaponAssembler,
  WeaponModelAssembly,
  WeaponModelFactory,
} from '../bodycam-sdk';
import type { CharacterSkeleton } from '../bodycam-sdk';

export interface CinematicHelicopterRig {
  root: THREE.Group;
  mainRotorPivot: THREE.Group;
  tailRotorPivot: THREE.Group;
  passengerSeatAnchor: THREE.Object3D;
  pilotSeatAnchor: THREE.Object3D;
  navStrobeMat: THREE.MeshStandardMaterial;
  pilotSkeleton: CharacterSkeleton;
  crewSkeleton: CharacterSkeleton;
  dispose: () => void;
}

export interface CinematicApcRig {
  root: THREE.Group;
  driverDoorPivot: THREE.Group;
  passengerDoorPivot: THREE.Group;
  wheels: THREE.Object3D[];
  passengerSeatAnchor: THREE.Object3D;
  driverSeatAnchor: THREE.Object3D;
  beaconMat: THREE.MeshStandardMaterial;
  headlightMat: THREE.MeshStandardMaterial;
  headlightBeam: THREE.SpotLight;
  dispose: () => void;
}

export interface GunCamRig {
  root: THREE.Group;
  weaponPivot: THREE.Group;
  cameraAnchor: THREE.Object3D;
  muzzleFlashMesh: THREE.Mesh;
  muzzleLight: THREE.PointLight;
  laserBeam: THREE.Mesh;
  assembly: WeaponModelAssembly;
  dispose: () => void;
}

/**
 * Multi-part 3D Tactical Transport Helicopter ("VALKYRIE 2-1") with open troop bay,
 * cockpit canopy, seated pilot + crew chief, landing skids, navigation strobes,
 * and spinning main & tail rotors.
 */
export function buildCinematicHelicopter(isSoftwareGl: boolean): CinematicHelicopterRig {
  const root = new THREE.Group();
  root.name = 'CinematicTransportHelicopter';
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geos.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    mats.push(m);
    return m;
  };

  const hullMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x2a312c, roughness: 0.64, metalness: 0.36 }),
  );
  const darkMetalMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x16191d, roughness: 0.48, metalness: 0.68 }),
  );
  const interiorMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x1d2226, roughness: 0.85, metalness: 0.16 }),
  );
  const canopyGlassMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x182530,
      roughness: 0.14,
      metalness: 0.25,
      transparent: true,
      opacity: 0.45,
    }),
  );
  const navStrobeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffc8c8,
      emissive: 0xef4444,
      emissiveIntensity: 3.0,
      roughness: 0.2,
    }),
  );
  const greenNavMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xbbf7d0,
      emissive: 0x10b981,
      emissiveIntensity: 2.4,
      roughness: 0.2,
    }),
  );
  const dashGlowMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0ea5e9,
      emissiveIntensity: 1.5,
      roughness: 0.3,
    }),
  );

  // Fuselage floor & roof framing the open troop bay (Z = -1.6 .. +1.6)
  const floorDeck = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.35, 0.22, 4.8)), hullMat);
  floorDeck.position.set(0, 0.82, 0.1);
  floorDeck.receiveShadow = true;
  floorDeck.castShadow = !isSoftwareGl;
  root.add(floorDeck);

  const roofDeck = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.28, 0.36, 4.5)), hullMat);
  roofDeck.position.set(0, 2.54, 0.25);
  roofDeck.castShadow = !isSoftwareGl;
  root.add(roofDeck);

  // Forward cockpit nose & instrument console (facing -Z)
  const nose = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.12, 0.92, 1.85)), hullMat);
  nose.position.set(0, 1.24, -2.95);
  nose.rotation.x = 0.16;
  root.add(nose);

  const cockpitGlass = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(2.04, 0.86, 1.42)),
    canopyGlassMat,
  );
  cockpitGlass.position.set(0, 1.98, -2.55);
  cockpitGlass.rotation.x = 0.28;
  root.add(cockpitGlass);

  const dash = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.78, 0.34, 0.42)), darkMetalMat);
  dash.position.set(0, 1.44, -2.25);
  root.add(dash);

  const dashScreen = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(1.3, 0.16)), dashGlowMat);
  dashScreen.position.set(0, 1.5, -2.03);
  root.add(dashScreen);

  // Rear bulkhead wall separating troop bay from turbine bay
  const rearWall = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.26, 1.52, 0.28)), interiorMat);
  rearWall.position.set(0, 1.66, 2.15);
  root.add(rearWall);

  // Structural corner pillars around the open troop doors (so FP mouse-look sees authentic framing!)
  for (const sx of [-1.06, 1.06]) {
    for (const sz of [-1.35, 1.55]) {
      const pillar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.14, 1.54, 0.18)), darkMetalMat);
      pillar.position.set(sx, 1.66, sz);
      root.add(pillar);
    }
    // Overhead grab rail along cabin ceiling
    const rail = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.018, 0.018, 2.75, 8)),
      darkMetalMat,
    );
    rail.rotation.x = Math.PI * 0.5;
    rail.position.set(sx * 0.72, 2.26, 0.15);
    root.add(rail);
  }

  // Troop benches along left & right walls
  for (const sx of [-0.72, 0.72]) {
    const bench = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.42, 0.08, 2.25)), interiorMat);
    bench.position.set(sx, 1.24, 0.25);
    root.add(bench);
  }

  // Twin turbine pods on roof
  for (const sx of [-0.62, 0.62]) {
    const turbine = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.32, 0.36, 2.35, 12)),
      darkMetalMat,
    );
    turbine.rotation.x = Math.PI * 0.5;
    turbine.position.set(sx, 2.86, 0.65);
    root.add(turbine);
  }

  // Tail boom & vertical stabilizer fin extending toward +Z
  const tailBoom = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.24, 0.46, 5.6, 10)),
    hullMat,
  );
  tailBoom.rotation.x = Math.PI * 0.5;
  tailBoom.position.set(0, 2.02, 5.05);
  root.add(tailBoom);

  const tailFin = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.16, 1.68, 0.92)), hullMat);
  tailFin.position.set(0, 2.68, 7.65);
  tailFin.rotation.x = -0.25;
  root.add(tailFin);

  const horizStab = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.35, 0.1, 0.52)), hullMat);
  horizStab.position.set(0, 2.05, 6.8);
  root.add(horizStab);

  // Heavy twin landing skids & cross-struts
  for (const sx of [-1.22, 1.22]) {
    const skid = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.065, 0.065, 5.2, 10)),
      darkMetalMat,
    );
    skid.rotation.x = Math.PI * 0.5;
    skid.position.set(sx, 0.08, -0.15);
    root.add(skid);

    for (const sz of [-1.35, 1.25]) {
      const strut = new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.045, 0.045, 0.9, 8)),
        darkMetalMat,
      );
      strut.position.set(sx * 0.88, 0.46, sz);
      strut.rotation.z = sx > 0 ? 0.32 : -0.32;
      root.add(strut);
    }
  }

  // Navigation strobes
  const tailStrobe = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.08, 8, 6)), navStrobeMat);
  tailStrobe.position.set(0, 3.54, 7.82);
  root.add(tailStrobe);

  const stbdLight = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.065, 8, 6)), greenNavMat);
  stbdLight.position.set(1.22, 2.48, -1.35);
  root.add(stbdLight);

  const portLight = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.065, 8, 6)), navStrobeMat);
  portLight.position.set(-1.22, 2.48, -1.35);
  root.add(portLight);

  // Main 4-blade rotor assembly
  const mainRotorPivot = new THREE.Group();
  mainRotorPivot.position.set(0, 3.22, 0.05);
  root.add(mainRotorPivot);

  const mast = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.14, 0.18, 0.56, 10)),
    darkMetalMat,
  );
  mast.position.set(0, -0.18, 0);
  mainRotorPivot.add(mast);

  const bladeGeo = trackGeo(new THREE.BoxGeometry(5.6, 0.035, 0.32));
  for (let b = 0; b < 4; b++) {
    const bladePivot = new THREE.Group();
    bladePivot.rotation.y = (b * Math.PI) / 2;
    const blade = new THREE.Mesh(bladeGeo, darkMetalMat);
    blade.position.set(2.85, 0.06, 0);
    bladePivot.add(blade);
    mainRotorPivot.add(bladePivot);
  }

  // Tail rotor assembly
  const tailRotorPivot = new THREE.Group();
  tailRotorPivot.position.set(0.24, 3.12, 7.72);
  root.add(tailRotorPivot);
  const tailBladeGeo = trackGeo(new THREE.BoxGeometry(0.03, 1.38, 0.14));
  const tb1 = new THREE.Mesh(tailBladeGeo, darkMetalMat);
  const tb2 = new THREE.Mesh(tailBladeGeo, darkMetalMat);
  tb2.rotation.x = Math.PI * 0.5;
  tailRotorPivot.add(tb1, tb2);

  // Seated Pilot + Seated Crew Chief inside helicopter using real anatomical CharacterSkeletons
  const pilotOp = operatorAssetLoader.loadProceduralOperator('MALE', {
    previewMode: true,
    uniformId: 'ffa',
    gear: {
      uniformId: 'ffa',
      helmetType: 'mich',
      helmetColor: 'black',
      eyewear: 'tinted_visor',
      faceGear: 'balaclava',
    },
  });
  const pilotSkeleton = pilotOp.skeleton;
  pilotSkeleton.setFirstPersonHeadShadowOnly(false);
  pilotSkeleton.root.position.set(0.46, 0.52, -1.68);
  pilotSkeleton.root.rotation.y = 0; // facing -Z cockpit glass
  pilotSkeleton.leftLeg.thigh.rotation.x = -1.35;
  pilotSkeleton.rightLeg.thigh.rotation.x = -1.35;
  pilotSkeleton.leftLeg.shin.rotation.x = 1.25;
  pilotSkeleton.rightLeg.shin.rotation.x = 1.25;
  pilotSkeleton.rightArm.upperArm.rotation.set(-0.62, 0.12, -0.1);
  pilotSkeleton.leftArm.upperArm.rotation.set(-0.55, -0.1, 0.1);
  root.add(pilotSkeleton.root);

  const crewOp = operatorAssetLoader.loadProceduralOperator('FEMALE', {
    previewMode: true,
    uniformId: 'infection',
    gear: {
      uniformId: 'infection',
      helmetType: 'mil_tec',
      helmetColor: 'olive_drab',
      eyewear: 'clear_glasses',
    },
  });
  const crewSkeleton = crewOp.skeleton;
  crewSkeleton.setFirstPersonHeadShadowOnly(false);
  crewSkeleton.root.position.set(-0.72, 0.48, 0.18);
  crewSkeleton.root.rotation.y = -Math.PI * 0.5; // seated on port bench facing player across cabin
  crewSkeleton.leftLeg.thigh.rotation.x = -1.35;
  crewSkeleton.rightLeg.thigh.rotation.x = -1.35;
  crewSkeleton.leftLeg.shin.rotation.x = 1.25;
  crewSkeleton.rightLeg.shin.rotation.x = 1.25;
  crewSkeleton.rightArm.upperArm.rotation.set(-0.45, 0.15, -0.12);
  crewSkeleton.leftArm.upperArm.rotation.set(-0.45, -0.15, 0.12);
  root.add(crewSkeleton.root);

  // Camera seat anchor on starboard troop bench (looking out & across cabin with live mouse look)
  const passengerSeatAnchor = new THREE.Object3D();
  passengerSeatAnchor.position.set(0.66, 1.94, 0.22);
  root.add(passengerSeatAnchor);

  const pilotSeatAnchor = new THREE.Object3D();
  pilotSeatAnchor.position.set(0.46, 1.85, -1.68);
  root.add(pilotSeatAnchor);

  return {
    root,
    mainRotorPivot,
    tailRotorPivot,
    passengerSeatAnchor,
    pilotSeatAnchor,
    navStrobeMat,
    pilotSkeleton,
    crewSkeleton,
    dispose: () => {
      pilotSkeleton.dispose();
      crewSkeleton.dispose();
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

/**
 * Multi-part 3D Armored Tactical APC with articulated driver & passenger doors,
 * rotating heavy off-road wheels, interior dash, halogen headlights, and roof amber strobe.
 */
export function buildCinematicApc(isSoftwareGl: boolean): CinematicApcRig {
  const root = new THREE.Group();
  root.name = 'CinematicArmoredApc';
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geos.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    mats.push(m);
    return m;
  };

  const armorMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x313831, roughness: 0.68, metalness: 0.36 }),
  );
  const darkMetalMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x171a1e, roughness: 0.52, metalness: 0.64 }),
  );
  const tireMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x151618, roughness: 0.92, metalness: 0.05 }),
  );
  const glassMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1c2b36,
      roughness: 0.16,
      metalness: 0.2,
      transparent: true,
      opacity: 0.42,
    }),
  );
  const beaconMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xfef08a,
      emissive: 0xf59e0b,
      emissiveIntensity: 2.8,
      roughness: 0.2,
    }),
  );
  const headlightMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xfff8e7,
      emissive: 0xffedd5,
      emissiveIntensity: 3.2,
      roughness: 0.15,
    }),
  );
  const dashMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x11161c,
      emissive: 0x34d399,
      emissiveIntensity: 0.35,
      roughness: 0.5,
    }),
  );

  // Forward faces -Z
  // Lower armored chassis + engine hood + rear troop compartment (leaving front cab sides open for articulated doors)
  const lowerHull = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.52, 0.72, 6.2)), armorMat);
  lowerHull.position.set(0, 0.92, 0);
  lowerHull.castShadow = !isSoftwareGl;
  lowerHull.receiveShadow = true;
  root.add(lowerHull);

  const hood = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.38, 0.68, 1.95)), armorMat);
  hood.position.set(0, 1.56, -2.05);
  hood.rotation.x = 0.08;
  root.add(hood);

  const rearBody = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.5, 1.32, 3.0)), armorMat);
  rearBody.position.set(0, 1.92, 1.55);
  rearBody.castShadow = !isSoftwareGl;
  root.add(rearBody);

  const cabRoof = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.44, 0.18, 1.65)), armorMat);
  cabRoof.position.set(0, 2.48, -0.58);
  root.add(cabRoof);

  // Armored windshield + interior dashboard
  const windshield = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.16, 0.72, 0.08)), glassMat);
  windshield.position.set(0, 2.02, -1.32);
  windshield.rotation.x = -0.22;
  root.add(windshield);

  const dashboard = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.18, 0.36, 0.44)), dashMat);
  dashboard.position.set(0, 1.52, -1.12);
  root.add(dashboard);

  // Front A-pillars
  for (const sx of [-1.14, 1.14]) {
    const pillar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.14, 1.24, 0.16)), darkMetalMat);
    pillar.position.set(sx, 1.88, -1.24);
    root.add(pillar);
  }

  // Articulated Driver Door (Left / -X side, hinged at front edge Z = -1.24)
  const driverDoorPivot = new THREE.Group();
  driverDoorPivot.position.set(-1.24, 1.52, -1.22);
  root.add(driverDoorPivot);
  const dDoorLower = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.12, 0.78, 1.24)), armorMat);
  dDoorLower.position.set(0, -0.05, 0.62);
  const dDoorFrame = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.1, 0.54, 1.2)), glassMat);
  dDoorFrame.position.set(0, 0.56, 0.62);
  driverDoorPivot.add(dDoorLower, dDoorFrame);

  // Articulated Passenger Door (Right / +X side, hinged at front edge Z = -1.24)
  const passengerDoorPivot = new THREE.Group();
  passengerDoorPivot.position.set(1.24, 1.52, -1.22);
  root.add(passengerDoorPivot);
  const pDoorLower = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.12, 0.78, 1.24)), armorMat);
  pDoorLower.position.set(0, -0.05, 0.62);
  const pDoorFrame = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.1, 0.54, 1.2)), glassMat);
  pDoorFrame.position.set(0, 0.56, 0.62);
  passengerDoorPivot.add(pDoorLower, pDoorFrame);

  // Roof amber rotating beacon + front halogen headlights + single downward spot beam
  const roofBeacon = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.12, 0.14, 0.22, 10)),
    beaconMat,
  );
  roofBeacon.position.set(0, 2.68, -0.45);
  root.add(roofBeacon);

  for (const hx of [-0.88, 0.88]) {
    const hl = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.36, 0.18, 0.08)), headlightMat);
    hl.position.set(hx, 1.32, -3.12);
    root.add(hl);
  }

  const headlightBeam = new THREE.SpotLight(0xfff1d0, 24, 34, Math.PI * 0.34, 0.55, 1.3);
  headlightBeam.position.set(0, 1.4, -3.15);
  headlightBeam.target.position.set(0, 0.2, -16);
  root.add(headlightBeam, headlightBeam.target);

  // 6 Heavy Armored Tires
  const wheelGeo = trackGeo(new THREE.CylinderGeometry(0.56, 0.56, 0.38, 16));
  wheelGeo.rotateZ(Math.PI * 0.5);
  const hubGeo = trackGeo(new THREE.CylinderGeometry(0.24, 0.24, 0.42, 10));
  hubGeo.rotateZ(Math.PI * 0.5);
  const wheels: THREE.Object3D[] = [];
  for (const wz of [-2.05, 0.45, 2.05]) {
    for (const wx of [-1.36, 1.36]) {
      const wg = new THREE.Group();
      wg.position.set(wx, 0.56, wz);
      wg.add(new THREE.Mesh(wheelGeo, tireMat), new THREE.Mesh(hubGeo, darkMetalMat));
      root.add(wg);
      wheels.push(wg);
    }
  }

  // Interior driver & passenger anchors
  const driverSeatAnchor = new THREE.Object3D();
  driverSeatAnchor.position.set(-0.62, 0.58, -0.52);
  root.add(driverSeatAnchor);

  const passengerSeatAnchor = new THREE.Object3D();
  passengerSeatAnchor.position.set(0.62, 1.96, -0.52);
  root.add(passengerSeatAnchor);

  return {
    root,
    driverDoorPivot,
    passengerDoorPivot,
    wheels,
    passengerSeatAnchor,
    driverSeatAnchor,
    beaconMat,
    headlightMat,
    headlightBeam,
    dispose: () => {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

/**
 * Rail / Gun-Mounted Tactical Camera Rig for cinematic room-clearing & firefight kill shots.
 * Mounts an authentic M4A1 carbine (`WeaponModelFactory`) with top rail + PEQ laser + muzzle flash
 * so the camera sits offset beside the upper handguard rail looking tightly past the receiver/barrel
 * downrange at the target!
 */
export function buildGunCamRig(): GunCamRig {
  const root = new THREE.Group();
  root.name = 'CinematicGunCamRig';

  const weaponPivot = new THREE.Group();
  root.add(weaponPivot);

  const prof = resolveWeaponProfile('m4a1');
  const assembly = WeaponModelFactory.build({
    id: prof.id,
    holdClass: prof.holdClass,
    barrelLengthM: prof.barrelLengthM,
    visualStyle: prof.visualStyle,
    finish: prof.finish,
    railType: prof.railType,
    isRevolver: prof.isRevolver,
    boreAxisHeightM: prof.boreAxisHeightM,
    rightHandSocket: prof.rightHandSocket,
    leftHandSocket: prof.leftHandSocket,
    muzzleOffset: prof.muzzleOffset,
    laserOffset: prof.laserOffset,
    supportsSuppressor: prof.supportsSuppressor,
    renderLayer: 0,
  });
  WeaponAssembler.applyAttachments(
    assembly,
    prof.massKg,
    prof.barrelLengthM,
    prof.magCapacity,
    {
      optic: 'holo_eotech',
      muzzle: 'comp_tactical',
      foregrip: 'grip_angled',
      tactical: 'peq15',
    },
    { thirdPersonMode: false },
  );
  weaponPivot.add(assembly.group);

  // Camera mounted to right upper Picatinny rail slightly behind muzzle looking downrange (-Z)
  const cameraAnchor = new THREE.Object3D();
  cameraAnchor.position.set(0.088, 0.082, -0.04);
  cameraAnchor.rotation.set(-0.015, 0.045, 0.06); // crisp canted gun-cam look!
  weaponPivot.add(cameraAnchor);

  const flashGeo = new THREE.OctahedronGeometry(0.13, 0);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffd166,
    transparent: true,
    opacity: 0.92,
  });
  const muzzleFlashMesh = new THREE.Mesh(flashGeo, flashMat);
  muzzleFlashMesh.position.set(0, 0.055, -0.68);
  muzzleFlashMesh.visible = false;
  weaponPivot.add(muzzleFlashMesh);

  const muzzleLight = new THREE.PointLight(0xffb74d, 0, 12, 1.5);
  muzzleLight.position.set(0, 0.08, -0.74);
  weaponPivot.add(muzzleLight);

  const laserGeo = new THREE.CylinderGeometry(0.0022, 0.0022, 18, 6);
  laserGeo.rotateX(Math.PI * 0.5);
  const laserMat = new THREE.MeshBasicMaterial({
    color: 0xef4444,
    transparent: true,
    opacity: 0.45,
  });
  const laserBeam = new THREE.Mesh(laserGeo, laserMat);
  laserBeam.position.set(-0.03, 0.06, -9.2);
  weaponPivot.add(laserBeam);

  return {
    root,
    weaponPivot,
    cameraAnchor,
    muzzleFlashMesh,
    muzzleLight,
    laserBeam,
    assembly,
    dispose: () => {
      assembly.dispose();
      flashGeo.dispose();
      flashMat.dispose();
      laserGeo.dispose();
      laserMat.dispose();
    },
  };
}

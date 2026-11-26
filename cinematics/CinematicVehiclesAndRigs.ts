import * as THREE from 'three';
import {
  operatorAssetLoader,
  poseSeatedOperator,
  resolveWeaponProfile,
  WeaponAssembler,
  WeaponModelAssembly,
  WeaponModelFactory,
} from '../bodycam-sdk';
import type { CharacterSkeleton, OperatorId, OperatorUniformId } from '../bodycam-sdk';

/** Natural forward-left 3/4 gaze inside the helicopter troop bay framing squadmate, door gunner & cockpit pilot. */
export const HELI_DEFAULT_CABIN_YAW_RAD = THREE.MathUtils.degToRad(30);

export interface HelicopterCrewCombatState {
  dt: number;
  /** 0..1 aggregate warzone combat intensity driving idle -> alert -> firing transitions */
  combatIntensity01: number;
  /** True during active door-gunner firing bursts */
  gunnerFiring: boolean;
  /** True during active jump-seat squadmate suppressive bursts */
  squadmateFiring: boolean;
  /** Optional world-space ground target coordinate for live door-gunner tracking & tracers */
  aimTargetWorldPos?: THREE.Vector3 | null;
}

export interface CinematicHelicopterRig {
  root: THREE.Group;
  mainRotorPivot: THREE.Group;
  tailRotorPivot: THREE.Group;
  passengerSeatAnchor: THREE.Object3D;
  pilotSeatAnchor: THREE.Object3D;
  navStrobeMat: THREE.MeshStandardMaterial;
  pilotSkeleton: CharacterSkeleton;
  doorGunnerSkeleton: CharacterSkeleton;
  crewSkeleton: CharacterSkeleton;
  crewWeaponMount: THREE.Group;
  doorGunPivot: THREE.Group;
  updateCrew: (timeSec: number, stateOrFiring?: boolean | HelicopterCrewCombatState) => void;
  getCrewEngagementState: () => { gunnerEngage01: number; squadEngage01: number };
  getDoorGunMuzzleWorldPosition: (out: THREE.Vector3) => THREE.Vector3;
  dispose: () => void;
}

export interface CinematicEscortGunshipRig {
  root: THREE.Group;
  mainRotorPivot: THREE.Group;
  tailRotorPivot: THREE.Group;
  navStrobeMat: THREE.MeshStandardMaterial;
  updateCombat: (
    timeSec: number,
    dt: number,
    firing: boolean,
    aimTargetWorldPos?: THREE.Vector3 | null,
  ) => void;
  getMuzzleWorldPosition: (out: THREE.Vector3) => THREE.Vector3;
  isFiring: () => boolean;
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

export interface ArmedCinematicOperator {
  skeleton: CharacterSkeleton;
  weaponMount: THREE.Group;
  weaponAssembly: WeaponModelAssembly;
  muzzleFlashMesh: THREE.Mesh;
  dispose: () => void;
}

function buildCompactRifleAssembly(weaponId: string): WeaponModelAssembly {
  const prof = resolveWeaponProfile(weaponId);
  const asm = WeaponModelFactory.build({
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
    asm,
    prof.massKg,
    prof.barrelLengthM,
    prof.magCapacity,
    {
      optic: 'holo_eotech',
      muzzle: 'comp_tactical',
      foregrip: 'grip_angled',
      tactical: 'peq15',
    },
    { thirdPersonMode: true },
  );
  return asm;
}

/**
 * Builds an armed cinematic operator (allied breach squadmate or corridor hostile) with
 * rifle mounted cleanly on `skeleton.chest` + muzzle flash mesh for animated gunfights.
 */
export function buildArmedCinematicOperator(opts: {
  operatorId: OperatorId;
  uniformId: OperatorUniformId;
  helmetType: 'none' | 'mich' | 'mil_tec';
  helmetColor: 'black' | 'olive_drab' | 'desert_tan' | 'ranger_green' | 'coyote_brown' | 'uniform';
  faceGear: 'open_face' | 'neck_gaiter' | 'balaclava';
  weaponId: string;
}): ArmedCinematicOperator {
  const loaded = operatorAssetLoader.loadProceduralOperator(opts.operatorId, {
    previewMode: true,
    uniformId: opts.uniformId,
    gear: {
      uniformId: opts.uniformId,
      helmetType: opts.helmetType,
      helmetColor: opts.helmetColor,
      faceGear: opts.faceGear,
      eyewear: 'clear_glasses',
    },
  });
  const skeleton = loaded.skeleton;
  skeleton.setFirstPersonHeadShadowOnly(false);

  const weaponAssembly = buildCompactRifleAssembly(opts.weaponId);
  const weaponMount = new THREE.Group();
  weaponMount.add(weaponAssembly.group);
  skeleton.chest.add(weaponMount);

  const flashGeo = new THREE.OctahedronGeometry(0.11, 0);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffd166,
    transparent: true,
    opacity: 0.92,
  });
  const muzzleFlashMesh = new THREE.Mesh(flashGeo, flashMat);
  muzzleFlashMesh.position.set(0, 0.055, -0.66);
  muzzleFlashMesh.visible = false;
  weaponMount.add(muzzleFlashMesh);

  return {
    skeleton,
    weaponMount,
    weaponAssembly,
    muzzleFlashMesh,
    dispose: () => {
      skeleton.chest.remove(weaponMount);
      weaponAssembly.dispose();
      flashGeo.dispose();
      flashMat.dispose();
      skeleton.dispose();
    },
  };
}

/**
 * Multi-part 3D Tactical Transport Helicopter ("VALKYRIE 2-1") with open troop bay,
 * cockpit seats, cyclic/collective controls, interior cabin dome glow, landing skids,
 * spinning rotors, and properly two-bone-IK seated Pilot & Troop-Bay Crew Chief.
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
      opacity: 0.36,
      depthWrite: false,
    }),
  );
  const navStrobeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xfde68a,
      emissive: 0xf59e0b,
      emissiveIntensity: 2.2,
      roughness: 0.2,
    }),
  );
  const greenNavMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xbbf7d0,
      emissive: 0x10b981,
      emissiveIntensity: 2.2,
      roughness: 0.2,
    }),
  );
  const dashGlowMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0ea5e9,
      emissiveIntensity: 0.92,
      roughness: 0.35,
    }),
  );
  const harnessMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x363b2e, roughness: 0.88, metalness: 0.08 }),
  );
  const brassMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0xd9a83e, roughness: 0.28, metalness: 0.86 }),
  );

  // Fuselage floor (top surface Y = 0.93m) & roof (bottom surface Y = 2.40m -> 1.47m headroom)
  const floorDeck = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.42, 0.22, 4.9)), hullMat);
  floorDeck.position.set(0, 0.82, 0.05);
  floorDeck.receiveShadow = true;
  floorDeck.castShadow = !isSoftwareGl;
  root.add(floorDeck);

  const roofDeck = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.36, 0.34, 4.6)), hullMat);
  roofDeck.position.set(0, 2.57, 0.2);
  roofDeck.castShadow = !isSoftwareGl;
  root.add(roofDeck);

  // 3-Point Cabin Studio Lighting (strictly non-shadow-casting):
  // 1. Warm tungsten overhead dome light
  // 2. Soft starboard rim-key fill illuminating both door gunner & jump-seat squadmate faces/gear
  // 3. Cool forward cockpit avionics fill
  const cabinLight = new THREE.PointLight(0xffdbb5, 8.8, 7.8, 1.35);
  cabinLight.position.set(0.12, 2.26, -0.15);
  cabinLight.castShadow = false;
  root.add(cabinLight);

  const crewKeyFillLight = new THREE.PointLight(0xfff2e0, 5.4, 6.4, 1.35);
  crewKeyFillLight.position.set(0.48, 2.02, -0.22);
  crewKeyFillLight.castShadow = false;
  root.add(crewKeyFillLight);

  const cockpitFillLight = new THREE.PointLight(0x7dd3fc, 3.6, 4.8, 1.5);
  cockpitFillLight.position.set(0.25, 1.98, -1.78);
  cockpitFillLight.castShadow = false;
  root.add(cockpitFillLight);

  // Forward cockpit nose & thin multi-pane windshield (replaces legacy solid blue canopy box!)
  const nose = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.14, 0.86, 1.72)), hullMat);
  nose.position.set(0, 1.24, -2.88);
  nose.rotation.x = 0.16;
  root.add(nose);

  const frontWindshield = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(1.94, 0.84, 0.026)),
    canopyGlassMat,
  );
  frontWindshield.position.set(0, 1.98, -2.84);
  frontWindshield.rotation.x = -0.34;
  root.add(frontWindshield);

  for (const sx of [-1.02, 1.02]) {
    const sidePane = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.026, 0.78, 1.12)),
      canopyGlassMat,
    );
    sidePane.position.set(sx, 1.96, -2.18);
    const mullion = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.08, 0.94, 0.09)), darkMetalMat);
    mullion.position.set(sx * 0.98, 1.96, -2.74);
    mullion.rotation.x = -0.34;
    root.add(sidePane, mullion);
  }
  const centerMullion = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.06, 0.9, 0.07)), darkMetalMat);
  centerMullion.position.set(0, 1.98, -2.83);
  centerMullion.rotation.x = -0.34;
  root.add(centerMullion);

  const dash = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.82, 0.34, 0.42)), darkMetalMat);
  dash.position.set(0, 1.44, -2.25);
  const dashHood = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.86, 0.07, 0.48)), darkMetalMat);
  dashHood.position.set(0, 1.63, -2.24);
  root.add(dash, dashHood);

  const dashScreen = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(1.24, 0.14)), dashGlowMat);
  dashScreen.position.set(0, 1.49, -2.035);
  root.add(dashScreen);

  // Pilot armored bucket seat + cyclic stick + collective lever
  const pilotSeatBase = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.48, 0.38, 0.46)), interiorMat);
  pilotSeatBase.position.set(0.48, 1.12, -1.58);
  const pilotSeatBack = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.46, 0.64, 0.1)), interiorMat);
  pilotSeatBack.position.set(0.48, 1.62, -1.38);
  const cyclicStick = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.018, 0.022, 0.56, 8)), darkMetalMat);
  cyclicStick.position.set(0.52, 1.26, -1.92);
  cyclicStick.rotation.x = 0.14;
  root.add(pilotSeatBase, pilotSeatBack, cyclicStick);

  // Tactical armored jump seat backrest, side bolsters & retention straps behind Jump-Seat Squadmate (-0.70, 0.93, -0.02)
  const jumpSeatFrame = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.08, 0.72, 0.54)), darkMetalMat);
  jumpSeatFrame.position.set(-0.96, 1.62, -0.02);
  const jumpSeatPad = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.06, 0.62, 0.46)), interiorMat);
  jumpSeatPad.position.set(-0.91, 1.62, -0.02);
  const jumpHeadrest = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.07, 0.18, 0.24)), interiorMat);
  jumpHeadrest.position.set(-0.92, 2.02, -0.02);
  const jumpStrapL = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.02, 0.48, 0.055)), harnessMat);
  jumpStrapL.position.set(-0.87, 1.66, -0.14);
  const jumpStrapR = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.02, 0.48, 0.055)), harnessMat);
  jumpStrapR.position.set(-0.87, 1.66, 0.10);
  // Gunner retention sling rail behind Door Gunner
  const gunnerStrap = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.03, 0.44, 0.06)), harnessMat);
  gunnerStrap.position.set(-0.56, 1.56, -0.78);
  root.add(jumpSeatFrame, jumpSeatPad, jumpHeadrest, jumpStrapL, jumpStrapR, gunnerStrap);

  // Rear bulkhead wall separating troop bay from turbine bay
  const rearWall = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.32, 1.54, 0.28)), interiorMat);
  rearWall.position.set(0, 1.68, 2.15);
  root.add(rearWall);

  // Structural corner pillars & overhead grab rails around open troop doors
  for (const sx of [-1.08, 1.08]) {
    for (const sz of [-1.32, 1.58]) {
      const pillar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.14, 1.56, 0.18)), darkMetalMat);
      pillar.position.set(sx, 1.68, sz);
      root.add(pillar);
    }
    const rail = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.018, 0.018, 2.75, 8)),
      darkMetalMat,
    );
    rail.rotation.x = Math.PI * 0.5;
    rail.position.set(sx * 0.72, 2.3, 0.15);
    root.add(rail);
  }

  // Troop benches along port (-X) and starboard (+X) walls (top surface Y = 1.32m -> 0.39m above floor)
  for (const sx of [-0.76, 0.76]) {
    const bench = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.44, 0.08, 2.25)), interiorMat);
    bench.position.set(sx, 1.28, 0.25);
    const benchLegF = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.06, 0.34, 0.06)), darkMetalMat);
    benchLegF.position.set(sx, 1.1, -0.75);
    const benchLegR = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.06, 0.34, 0.06)), darkMetalMat);
    benchLegR.position.set(sx, 1.1, 1.25);
    root.add(bench, benchLegF, benchLegR);
  }

  // Twin turbine pods on roof
  for (const sx of [-0.62, 0.62]) {
    const turbine = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.32, 0.36, 2.35, 12)),
      darkMetalMat,
    );
    turbine.rotation.x = Math.PI * 0.5;
    turbine.position.set(sx, 2.9, 0.65);
    root.add(turbine);
  }

  // Tail boom & vertical stabilizer fin extending toward +Z
  const tailBoom = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.24, 0.46, 5.6, 10)),
    hullMat,
  );
  tailBoom.rotation.x = Math.PI * 0.5;
  tailBoom.position.set(0, 2.04, 5.05);
  root.add(tailBoom);

  const tailFin = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.16, 1.68, 0.92)), hullMat);
  tailFin.position.set(0, 2.7, 7.65);
  tailFin.rotation.x = -0.25;
  root.add(tailFin);

  const horizStab = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.35, 0.1, 0.52)), hullMat);
  horizStab.position.set(0, 2.07, 6.8);
  root.add(horizStab);

  // Heavy twin landing skids & cross-struts
  for (const sx of [-1.24, 1.24]) {
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
  tailStrobe.position.set(0, 3.56, 7.82);
  root.add(tailStrobe);

  const stbdLight = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.065, 8, 6)), greenNavMat);
  stbdLight.position.set(1.24, 2.5, -1.35);
  root.add(stbdLight);

  const portLight = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.065, 8, 6)), navStrobeMat);
  portLight.position.set(-1.24, 2.5, -1.35);
  root.add(portLight);

  // Main 4-blade rotor assembly
  const mainRotorPivot = new THREE.Group();
  mainRotorPivot.position.set(0, 3.24, 0.05);
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
  tailRotorPivot.position.set(0.24, 3.14, 7.72);
  root.add(tailRotorPivot);
  const tailBladeGeo = trackGeo(new THREE.BoxGeometry(0.03, 1.38, 0.14));
  const tb1 = new THREE.Mesh(tailBladeGeo, darkMetalMat);
  const tb2 = new THREE.Mesh(tailBladeGeo, darkMetalMat);
  tb2.rotation.x = Math.PI * 0.5;
  tailRotorPivot.add(tb1, tb2);

  // Port-side pintle-mounted 7.62mm Heavy Machine Gun rig inside open port doorway (-X)
  const doorGunPivot = new THREE.Group();
  doorGunPivot.position.set(-1.14, 1.58, -0.78);
  root.add(doorGunPivot);

  const pintlePost = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.028, 0.036, 0.64, 8)),
    darkMetalMat,
  );
  pintlePost.position.set(0.02, -0.32, 0);
  doorGunPivot.add(pintlePost);

  const gunAssemblyPivot = new THREE.Group();
  // YXZ order: pitch down (-15 deg on X) then yaw outward port (+90 deg on Y) into the warzone valley
  gunAssemblyPivot.rotation.order = 'YXZ';
  gunAssemblyPivot.rotation.set(-0.26, Math.PI * 0.5, 0);
  doorGunPivot.add(gunAssemblyPivot);

  const gunReceiver = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.14, 0.16, 0.56)), darkMetalMat);
  gunReceiver.position.set(0, 0.04, -0.05);
  const gunBarrel = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.024, 0.028, 0.72, 8)),
    darkMetalMat,
  );
  gunBarrel.rotation.x = Math.PI * 0.5;
  gunBarrel.position.set(0, 0.055, -0.66);
  const gunShroud = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.042, 0.044, 0.36, 8)),
    hullMat,
  );
  gunShroud.rotation.x = Math.PI * 0.5;
  gunShroud.position.set(0, 0.055, -0.48);
  const ammoBox = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.16, 0.2, 0.24)), hullMat);
  ammoBox.position.set(-0.14, -0.02, -0.08);
  const spadeGripL = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.03, 0.14, 0.03)), darkMetalMat);
  spadeGripL.position.set(-0.08, 0.04, 0.26);
  const spadeGripR = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.03, 0.14, 0.03)), darkMetalMat);
  spadeGripR.position.set(0.08, 0.04, 0.26);
  gunAssemblyPivot.add(gunReceiver, gunBarrel, gunShroud, ammoBox, spadeGripL, spadeGripR);

  const doorGunFlashMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.94 }),
  );
  const doorGunFlash = new THREE.Mesh(trackGeo(new THREE.OctahedronGeometry(0.16, 0)), doorGunFlashMat);
  doorGunFlash.position.set(0, 0.055, -1.08);
  doorGunFlash.visible = false;
  gunAssemblyPivot.add(doorGunFlash);

  const doorGunLight = new THREE.PointLight(0xffb74d, 0, 12, 1.4);
  doorGunLight.position.set(0, 0.08, -1.25);
  gunAssemblyPivot.add(doorGunLight);

  // Pooled glowing downward tracer bolts streaming out of the port door gun when firing
  const gunnerTracerGeo = trackGeo(new THREE.CylinderGeometry(0.016, 0.016, 2.4, 5));
  gunnerTracerGeo.rotateX(Math.PI * 0.5);
  const gunnerTracerMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xfef08a, transparent: true, opacity: 0.92 }),
  );
  const gunnerTracers: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const tr = new THREE.Mesh(gunnerTracerGeo, gunnerTracerMat);
    tr.visible = false;
    gunAssemblyPivot.add(tr);
    gunnerTracers.push(tr);
  }

  // Three fully visible IK-posed operators seated cleanly on cabin floor deck (Y = 0.93m):
  // 1. Cockpit Pilot forward-right (+0.44, 0.93, -1.52) visible down center aisle
  // 2. Active Port Door Gunner forward-left (-0.76, 0.93, -0.68) firing pintle LMG out open port door
  // 3. Seated Squadmate across-left (-0.70, 0.93, +0.08) facing directly toward player cradling rifle
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
  pilotSkeleton.root.position.set(0.44, 0.93, -1.52);
  pilotSkeleton.root.rotation.y = 0; // faces -Z through cockpit glass
  root.add(pilotSkeleton.root);

  const doorGunnerOp = operatorAssetLoader.loadProceduralOperator('MALE', {
    previewMode: true,
    uniformId: 'team_a',
    gear: {
      uniformId: 'team_a',
      helmetType: 'mil_tec',
      helmetColor: 'coyote_brown',
      eyewear: 'tinted_visor',
      faceGear: 'neck_gaiter',
    },
  });
  const doorGunnerSkeleton = doorGunnerOp.skeleton;
  doorGunnerSkeleton.setFirstPersonHeadShadowOnly(false);
  doorGunnerSkeleton.root.position.set(-0.76, 0.93, -0.78);
  doorGunnerSkeleton.root.rotation.y = Math.PI * 0.5; // faces -X straight out open port door onto pintle gun
  root.add(doorGunnerSkeleton.root);

  const crewOp = operatorAssetLoader.loadProceduralOperator('FEMALE', {
    previewMode: true,
    uniformId: 'team_a',
    gear: {
      uniformId: 'team_a',
      helmetType: 'mil_tec',
      helmetColor: 'desert_tan',
      eyewear: 'clear_glasses',
      faceGear: 'neck_gaiter',
    },
  });
  const crewSkeleton = crewOp.skeleton;
  crewSkeleton.setFirstPersonHeadShadowOnly(false);
  crewSkeleton.root.position.set(-0.70, 0.93, -0.02);
  crewSkeleton.root.rotation.y = -Math.PI * 0.42; // angled directly across-forward toward player camera
  root.add(crewSkeleton.root);

  const crewRifle = buildCompactRifleAssembly('m4a1');
  const crewWeaponMount = new THREE.Group();
  crewWeaponMount.add(crewRifle.group);
  crewSkeleton.chest.add(crewWeaponMount);

  // Jump-seat squadmate muzzle flash & pooled 5.56mm suppressive tracers
  const crewFlashMesh = new THREE.Mesh(trackGeo(new THREE.OctahedronGeometry(0.11, 0)), doorGunFlashMat);
  crewFlashMesh.position.set(0, 0.055, -0.66);
  crewFlashMesh.visible = false;
  crewWeaponMount.add(crewFlashMesh);

  const crewTracerGeo = trackGeo(new THREE.CylinderGeometry(0.011, 0.011, 1.8, 5));
  crewTracerGeo.rotateX(Math.PI * 0.5);
  const crewTracers: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const ct = new THREE.Mesh(crewTracerGeo, gunnerTracerMat);
    ct.visible = false;
    crewWeaponMount.add(ct);
    crewTracers.push(ct);
  }

  // Pooled spinning brass shell casings ejecting from the port door gun receiver onto the cabin deck
  const brassGeo = trackGeo(new THREE.CylinderGeometry(0.008, 0.008, 0.036, 5));
  brassGeo.rotateZ(Math.PI * 0.5);
  interface BrassSlot {
    mesh: THREE.Mesh;
    vel: THREE.Vector3;
    age: number;
    maxAge: number;
    active: boolean;
  }
  const brassPool: BrassSlot[] = [];
  for (let i = 0; i < 6; i++) {
    const bm = new THREE.Mesh(brassGeo, brassMat);
    bm.visible = false;
    doorGunPivot.add(bm);
    brassPool.push({
      mesh: bm,
      vel: new THREE.Vector3(),
      age: 0,
      maxAge: 0.65,
      active: false,
    });
  }
  let brassCursor = 0;
  let lastBrassBucket = -1;

  // Smooth damped idle-to-firing crew engagement state & world-space turret tracking scratch vars
  let gunnerEngage01 = 0;
  let squadEngage01 = 0;
  let gunPitchCurrent = -0.22;
  let gunYawCurrent = Math.PI * 0.5;
  let activeTargetRangeM = 34.0;
  const _invHeliMat = new THREE.Matrix4();
  const _localAimTarget = new THREE.Vector3();
  const _aimDir = new THREE.Vector3();

  const updateCrew = (
    timeSec: number,
    stateOrFiring: boolean | HelicopterCrewCombatState = false,
  ): void => {
    const cfg: HelicopterCrewCombatState =
      typeof stateOrFiring === 'boolean'
        ? {
            dt: 1 / 60,
            combatIntensity01: stateOrFiring ? 0.9 : 0.1,
            gunnerFiring: stateOrFiring,
            squadmateFiring: false,
            aimTargetWorldPos: null,
          }
        : stateOrFiring;

    const safeDt = Math.min(0.05, Math.max(0.001, cfg.dt));
    const desiredGunnerEngage = cfg.gunnerFiring
      ? 1.0
      : cfg.combatIntensity01 > 0.35
        ? THREE.MathUtils.lerp(0.28, 0.55, (cfg.combatIntensity01 - 0.35) / 0.65)
        : 0.04;
    const desiredSquadEngage = cfg.squadmateFiring
      ? 1.0
      : cfg.combatIntensity01 > 0.42
        ? THREE.MathUtils.lerp(0.22, 0.48, (cfg.combatIntensity01 - 0.42) / 0.58)
        : 0.0;

    gunnerEngage01 = THREE.MathUtils.damp(gunnerEngage01, desiredGunnerEngage, 6.2, safeDt);
    squadEngage01 = THREE.MathUtils.damp(squadEngage01, desiredSquadEngage, 5.4, safeDt);

    // Compute world-space pintle gun tracking toward locked ground target (tank, APC, infantry)
    let desiredYaw = Math.PI * 0.5 + Math.sin(timeSec * 0.95) * THREE.MathUtils.lerp(0.08, 0.18, gunnerEngage01);
    let desiredPitch = THREE.MathUtils.lerp(-0.14, -0.28, gunnerEngage01) + Math.sin(timeSec * 1.3) * 0.04;
    activeTargetRangeM = 34.0;

    if (cfg.aimTargetWorldPos && gunnerEngage01 > 0.18) {
      root.updateMatrixWorld(true);
      _invHeliMat.copy(root.matrixWorld).invert();
      _localAimTarget.copy(cfg.aimTargetWorldPos).applyMatrix4(_invHeliMat);
      _aimDir.subVectors(_localAimTarget, doorGunPivot.position);
      const dist = _aimDir.length();
      if (dist > 1.5) {
        activeTargetRangeM = THREE.MathUtils.clamp(dist, 10.0, 65.0);
        // Pintle barrel points along local -Z inside gunAssemblyPivot (YXZ order)
        const rawYaw = Math.atan2(-_aimDir.x, -_aimDir.z);
        const horizDist = Math.max(0.5, Math.hypot(_aimDir.x, _aimDir.z));
        const rawPitch = Math.atan2(_aimDir.y, horizDist);
        // Clamp traverse cleanly inside open port doorway arc so gun never clips cabin pillars
        desiredYaw = THREE.MathUtils.clamp(rawYaw, Math.PI * 0.5 - 0.64, Math.PI * 0.5 + 0.64);
        desiredPitch = THREE.MathUtils.clamp(rawPitch, -0.82, -0.05);
      }
    }

    gunYawCurrent = THREE.MathUtils.damp(gunYawCurrent, desiredYaw, 8.5, safeDt);
    gunPitchCurrent = THREE.MathUtils.damp(gunPitchCurrent, desiredPitch, 8.5, safeDt);

    const isGunnerActivelyFiring = cfg.gunnerFiring && gunnerEngage01 > 0.62;
    const firePulse = isGunnerActivelyFiring ? (Math.sin(timeSec * 58.0) > 0.05 ? 1 : 0) : 0;

    gunAssemblyPivot.rotation.set(
      gunPitchCurrent + firePulse * 0.028,
      gunYawCurrent,
      0,
    );
    gunAssemblyPivot.position.set(firePulse * 0.028, 0, 0);

    doorGunFlash.visible = firePulse > 0;
    doorGunFlash.rotation.z = timeSec * 52;
    doorGunLight.intensity = firePulse > 0 ? 18 : 0;

    // Stream pooled golden 7.62mm tracers directly from muzzle to live target range
    for (let i = 0; i < gunnerTracers.length; i++) {
      const tr = gunnerTracers[i];
      if (!isGunnerActivelyFiring) {
        tr.visible = false;
        continue;
      }
      const phase = (timeSec * 4.4 + i * 0.25) % 1;
      tr.visible = phase < 0.88;
      tr.position.set(0, 0.055, -1.6 - phase * Math.max(8, activeTargetRangeM - 2.0));
    }

    // Eject spinning brass shell casings from pintle breech onto cabin deck when firing
    if (isGunnerActivelyFiring) {
      const brassBucket = Math.floor(timeSec * 12.0);
      if (brassBucket !== lastBrassBucket) {
        lastBrassBucket = brassBucket;
        const slot = brassPool[brassCursor];
        brassCursor = (brassCursor + 1) % brassPool.length;
        slot.active = true;
        slot.age = 0;
        slot.maxAge = 0.58;
        slot.mesh.position.set(0.18, 0.06, 0.04);
        slot.vel.set(0.75 + (brassCursor % 3) * 0.18, 0.85 + (brassCursor % 2) * 0.22, 0.38 - (brassCursor % 3) * 0.14);
        slot.mesh.visible = true;
      }
    }
    for (let i = 0; i < brassPool.length; i++) {
      const b = brassPool[i];
      if (!b.active) continue;
      b.age += safeDt;
      if (b.age >= b.maxAge) {
        b.active = false;
        b.mesh.visible = false;
      } else {
        b.vel.y -= 9.8 * safeDt;
        b.mesh.position.addScaledVector(b.vel, safeDt);
        if (b.mesh.position.y < -0.62) {
          b.mesh.position.y = -0.62;
          b.vel.y = Math.abs(b.vel.y) * 0.25;
          b.vel.x *= 0.6;
          b.vel.z *= 0.6;
        }
        b.mesh.rotation.x += safeDt * 18.0;
        b.mesh.rotation.y += safeDt * 14.0;
      }
    }

    // Jump-seat squadmate suppressive bursts & pooled 5.56mm tracers
    const isSquadActivelyFiring = cfg.squadmateFiring && squadEngage01 > 0.7;
    const squadPulse = isSquadActivelyFiring ? (Math.sin(timeSec * 44.0) > 0.18 ? 1 : 0) : 0;
    crewFlashMesh.visible = squadPulse > 0;
    crewFlashMesh.rotation.z = timeSec * 48;
    for (let i = 0; i < crewTracers.length; i++) {
      const ct = crewTracers[i];
      if (!isSquadActivelyFiring) {
        ct.visible = false;
        continue;
      }
      const p = (timeSec * 3.8 + i * 0.33) % 1;
      ct.visible = p < 0.82;
      ct.position.set(0, 0.055, -1.4 - p * 26.0);
    }

    const gunnerHeadYaw = THREE.MathUtils.clamp(gunYawCurrent - Math.PI * 0.5, -0.45, 0.45) * 0.72;
    poseSeatedOperator(pilotSkeleton, 'heli_pilot', timeSec, {
      seatHeightAboveFloor: 0.44,
      headYawRad: Math.sin(timeSec * 0.45) * 0.14,
      headPitchRad: -0.05,
    });
    poseSeatedOperator(doorGunnerSkeleton, 'heli_door_gunner', timeSec, {
      seatHeightAboveFloor: 0.44,
      headYawRad: gunnerHeadYaw,
      headPitchRad: THREE.MathUtils.clamp(gunPitchCurrent * 0.65, -0.35, 0.05),
      recoilKick01: firePulse,
      combatEngage01: gunnerEngage01,
    });
    poseSeatedOperator(crewSkeleton, 'heli_crew', timeSec, {
      seatHeightAboveFloor: 0.44,
      headYawRad: THREE.MathUtils.lerp(0.18 + Math.sin(timeSec * 0.68) * 0.2, -0.28, squadEngage01),
      headPitchRad: THREE.MathUtils.lerp(-0.02, -0.14, squadEngage01),
      recoilKick01: squadPulse,
      combatEngage01: squadEngage01,
      weaponMount: crewWeaponMount,
    });
  };
  updateCrew(0, false);

  const getCrewEngagementState = (): { gunnerEngage01: number; squadEngage01: number } => ({
    gunnerEngage01,
    squadEngage01,
  });

  const getDoorGunMuzzleWorldPosition = (out: THREE.Vector3): THREE.Vector3 => {
    doorGunFlash.getWorldPosition(out);
    return out;
  };

  // Starboard passenger camera anchor placed toward rear bench (z = +0.96) so neutral +30deg forward-left
  // view simultaneously frames seated squadmate, active port door gunner, and cockpit pilot inside +/-32deg!
  const passengerSeatAnchor = new THREE.Object3D();
  passengerSeatAnchor.position.set(0.74, 2.0, 0.96);
  root.add(passengerSeatAnchor);

  const pilotSeatAnchor = new THREE.Object3D();
  pilotSeatAnchor.position.set(0.44, 1.98, -1.52);
  root.add(pilotSeatAnchor);

  return {
    root,
    mainRotorPivot,
    tailRotorPivot,
    passengerSeatAnchor,
    pilotSeatAnchor,
    navStrobeMat,
    pilotSkeleton,
    doorGunnerSkeleton,
    crewSkeleton,
    crewWeaponMount,
    doorGunPivot,
    updateCrew,
    getCrewEngagementState,
    getDoorGunMuzzleWorldPosition,
    dispose: () => {
      crewSkeleton.chest.remove(crewWeaponMount);
      crewRifle.dispose();
      pilotSkeleton.dispose();
      doorGunnerSkeleton.dispose();
      crewSkeleton.dispose();
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

/**
 * Lightweight wingman Escort Gunship ("VALKYRIE 2-2") with stub weapon pylons, rocket pods,
 * spinning rotors, navigation strobes, and pooled chin-turret tracer streams firing down into the warzone.
 */
export function buildEscortGunship(isSoftwareGl: boolean): CinematicEscortGunshipRig {
  const root = new THREE.Group();
  root.name = 'CinematicEscortGunship';
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
    new THREE.MeshStandardMaterial({ color: 0x262d28, roughness: 0.62, metalness: 0.4 }),
  );
  const darkMetalMat = trackMat(
    new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.45, metalness: 0.7 }),
  );
  const navStrobeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xfde68a,
      emissive: 0xf59e0b,
      emissiveIntensity: 2.6,
    }),
  );
  const flashMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.94 }),
  );
  const tracerMat = trackMat(
    new THREE.MeshBasicMaterial({ color: 0xfde047, transparent: true, opacity: 0.92 }),
  );

  // Sleek armored gunship fuselage, stub weapon wings, twin rocket pods, tail boom & skids
  const fuselage = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.72, 1.38, 4.6)), hullMat);
  fuselage.position.set(0, 1.55, 0);
  fuselage.castShadow = !isSoftwareGl;
  root.add(fuselage);

  const nose = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.42, 0.92, 1.8)), hullMat);
  nose.position.set(0, 1.38, -2.9);
  nose.rotation.x = 0.22;
  root.add(nose);

  const stubWings = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(4.6, 0.16, 0.92)), darkMetalMat);
  stubWings.position.set(0, 1.52, -0.35);
  root.add(stubWings);

  for (const sx of [-2.05, 2.05]) {
    const pod = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.24, 0.24, 1.45, 10)), darkMetalMat);
    pod.rotation.x = Math.PI * 0.5;
    pod.position.set(sx, 1.24, -0.4);
    root.add(pod);
  }

  const tailBoom = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.2, 0.4, 5.2, 10)),
    hullMat,
  );
  tailBoom.rotation.x = Math.PI * 0.5;
  tailBoom.position.set(0, 1.88, 4.75);
  root.add(tailBoom);

  const tailFin = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.14, 1.55, 0.85)), hullMat);
  tailFin.position.set(0, 2.48, 7.2);
  tailFin.rotation.x = -0.24;
  root.add(tailFin);

  const strobe = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.09, 8, 6)), navStrobeMat);
  strobe.position.set(0, 3.28, 7.36);
  root.add(strobe);

  // Main & tail rotors
  const mainRotorPivot = new THREE.Group();
  mainRotorPivot.position.set(0, 2.52, -0.05);
  root.add(mainRotorPivot);
  const bladeGeo = trackGeo(new THREE.BoxGeometry(5.2, 0.035, 0.3));
  for (let b = 0; b < 4; b++) {
    const bp = new THREE.Group();
    bp.rotation.y = (b * Math.PI) / 2;
    const bl = new THREE.Mesh(bladeGeo, darkMetalMat);
    bl.position.set(2.65, 0.04, 0);
    bp.add(bl);
    mainRotorPivot.add(bp);
  }

  const tailRotorPivot = new THREE.Group();
  tailRotorPivot.position.set(0.2, 2.86, 7.25);
  root.add(tailRotorPivot);
  const tailBladeGeo = trackGeo(new THREE.BoxGeometry(0.03, 1.25, 0.13));
  const tb1 = new THREE.Mesh(tailBladeGeo, darkMetalMat);
  const tb2 = new THREE.Mesh(tailBladeGeo, darkMetalMat);
  tb2.rotation.x = Math.PI * 0.5;
  tailRotorPivot.add(tb1, tb2);

  // Chin cannon turret + downward tracer stream pool
  const turretPivot = new THREE.Group();
  turretPivot.position.set(0, 0.82, -3.55);
  turretPivot.rotation.x = -0.38; // firing downward into combat valley
  root.add(turretPivot);

  const chinFlash = new THREE.Mesh(trackGeo(new THREE.OctahedronGeometry(0.24, 0)), flashMat);
  chinFlash.position.set(0, 0, -0.4);
  chinFlash.visible = false;
  turretPivot.add(chinFlash);

  const tracerGeo = trackGeo(new THREE.CylinderGeometry(0.03, 0.03, 3.4, 5));
  tracerGeo.rotateX(Math.PI * 0.5);
  const tracers: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const tMesh = new THREE.Mesh(tracerGeo, tracerMat);
    tMesh.visible = false;
    turretPivot.add(tMesh);
    tracers.push(tMesh);
  }

  let currentlyFiring = false;
  const _invEscortMat = new THREE.Matrix4();
  const _localTarget = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  turretPivot.rotation.order = 'YXZ';

  const updateCombat = (
    timeSec: number,
    dt: number,
    firing: boolean,
    aimTargetWorldPos?: THREE.Vector3 | null,
  ): void => {
    mainRotorPivot.rotation.y += dt * 28.0;
    tailRotorPivot.rotation.x += dt * 44.0;
    navStrobeMat.emissiveIntensity = Math.sin(timeSec * 8.2) > 0.6 ? 3.5 : 0.4;

    const pulse = firing && Math.sin(timeSec * 46.0) > -0.1;
    currentlyFiring = pulse;
    chinFlash.visible = pulse;
    chinFlash.rotation.z = timeSec * 40;

    let rangeM = 42.0;
    if (aimTargetWorldPos) {
      root.updateMatrixWorld(true);
      _invEscortMat.copy(root.matrixWorld).invert();
      _localTarget.copy(aimTargetWorldPos).applyMatrix4(_invEscortMat);
      _dir.subVectors(_localTarget, turretPivot.position);
      const d = _dir.length();
      if (d > 2) {
        rangeM = THREE.MathUtils.clamp(d, 12, 65);
        const rawYaw = Math.atan2(-_dir.x, -_dir.z);
        const horiz = Math.max(0.5, Math.hypot(_dir.x, _dir.z));
        const rawPitch = Math.atan2(_dir.y, horiz);
        turretPivot.rotation.y = THREE.MathUtils.clamp(rawYaw, -0.85, 0.85);
        turretPivot.rotation.x = THREE.MathUtils.clamp(rawPitch, -0.78, -0.08);
      }
    } else {
      turretPivot.rotation.y = Math.sin(timeSec * 1.1) * 0.24;
      turretPivot.rotation.x = -0.38;
    }

    for (let i = 0; i < tracers.length; i++) {
      const tr = tracers[i];
      if (!firing) {
        tr.visible = false;
        continue;
      }
      const p = (timeSec * 3.2 + i * 0.25) % 1;
      tr.visible = p < 0.88;
      tr.position.set(0, 0, -2.2 - p * Math.max(10, rangeM - 2.0));
    }
  };

  const getMuzzleWorldPosition = (out: THREE.Vector3): THREE.Vector3 => {
    chinFlash.getWorldPosition(out);
    return out;
  };

  const isFiring = (): boolean => currentlyFiring;

  return {
    root,
    mainRotorPivot,
    tailRotorPivot,
    navStrobeMat,
    updateCombat,
    getMuzzleWorldPosition,
    isFiring,
    dispose: () => {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

/**
 * Multi-part 3D Armored Tactical APC with articulated driver & passenger doors,
 * steering wheel column, rotating heavy off-road wheels, halogen headlights, and roof strobe.
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
      opacity: 0.38,
      depthWrite: false,
    }),
  );
  const beaconMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xfef08a,
      emissive: 0xf59e0b,
      emissiveIntensity: 2.6,
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

  // Lower armored chassis + hood + rear troop compartment
  const lowerHull = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.52, 0.72, 6.2)), armorMat);
  lowerHull.position.set(0, 0.86, 0);
  lowerHull.castShadow = !isSoftwareGl;
  lowerHull.receiveShadow = true;
  root.add(lowerHull);

  const hood = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.38, 0.68, 1.95)), armorMat);
  hood.position.set(0, 1.54, -2.05);
  hood.rotation.x = 0.08;
  root.add(hood);

  const rearBody = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.5, 1.38, 3.0)), armorMat);
  rearBody.position.set(0, 1.92, 1.55);
  rearBody.castShadow = !isSoftwareGl;
  root.add(rearBody);

  const cabRoof = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.44, 0.18, 1.65)), armorMat);
  cabRoof.position.set(0, 2.54, -0.58);
  root.add(cabRoof);

  // Subtle green dashboard ambient light inside cab
  const cabLight = new THREE.PointLight(0x86efac, 2.4, 4.2, 1.6);
  cabLight.position.set(0, 2.15, -0.72);
  root.add(cabLight);

  // Armored windshield + interior dashboard + driver steering wheel
  const windshield = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.16, 0.76, 0.08)), glassMat);
  windshield.position.set(0, 2.06, -1.32);
  windshield.rotation.x = -0.22;
  root.add(windshield);

  const dashboard = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.18, 0.36, 0.44)), dashMat);
  dashboard.position.set(0, 1.52, -1.12);
  root.add(dashboard);

  const wheelRim = new THREE.Mesh(trackGeo(new THREE.TorusGeometry(0.18, 0.022, 8, 16)), darkMetalMat);
  wheelRim.position.set(-0.62, 1.72, -0.92);
  wheelRim.rotation.x = 0.48;
  root.add(wheelRim);

  // Front A-pillars
  for (const sx of [-1.14, 1.14]) {
    const pillar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.14, 1.28, 0.16)), darkMetalMat);
    pillar.position.set(sx, 1.9, -1.24);
    root.add(pillar);
  }

  // Articulated Driver Door (-X)
  const driverDoorPivot = new THREE.Group();
  driverDoorPivot.position.set(-1.24, 1.54, -1.22);
  root.add(driverDoorPivot);
  const dDoorLower = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.12, 0.78, 1.24)), armorMat);
  dDoorLower.position.set(0, -0.05, 0.62);
  const dDoorFrame = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.1, 0.56, 1.2)), glassMat);
  dDoorFrame.position.set(0, 0.56, 0.62);
  driverDoorPivot.add(dDoorLower, dDoorFrame);

  // Articulated Passenger Door (+X)
  const passengerDoorPivot = new THREE.Group();
  passengerDoorPivot.position.set(1.24, 1.54, -1.22);
  root.add(passengerDoorPivot);
  const pDoorLower = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.12, 0.78, 1.24)), armorMat);
  pDoorLower.position.set(0, -0.05, 0.62);
  const pDoorFrame = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.1, 0.56, 1.2)), glassMat);
  pDoorFrame.position.set(0, 0.56, 0.62);
  passengerDoorPivot.add(pDoorLower, pDoorFrame);

  // Roof amber strobe + halogen headlights + forward beam
  const roofBeacon = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.12, 0.14, 0.22, 10)),
    beaconMat,
  );
  roofBeacon.position.set(0, 2.74, -0.45);
  root.add(roofBeacon);

  for (const hx of [-0.88, 0.88]) {
    const hl = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.36, 0.18, 0.08)), headlightMat);
    hl.position.set(hx, 1.32, -3.12);
    root.add(hl);
  }

  const headlightBeam = new THREE.SpotLight(0xfff1d0, 24, 38, Math.PI * 0.34, 0.55, 1.3);
  headlightBeam.position.set(0, 1.4, -3.15);
  headlightBeam.target.position.set(0, 0.2, -18);
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

  // Driver floor deck anchor (Y = 0.98m -> seated driver head sits at Y ≈ 2.22m, well below 2.45m roof!)
  const driverSeatAnchor = new THREE.Object3D();
  driverSeatAnchor.position.set(-0.62, 0.98, -0.52);
  root.add(driverSeatAnchor);

  const passengerSeatAnchor = new THREE.Object3D();
  passengerSeatAnchor.position.set(0.62, 2.04, -0.52);
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
 * so the camera looks tightly past the upper receiver/handguard downrange at targets.
 */
export function buildGunCamRig(): GunCamRig {
  const root = new THREE.Group();
  root.name = 'CinematicGunCamRig';

  const weaponPivot = new THREE.Group();
  root.add(weaponPivot);

  const assembly = buildCompactRifleAssembly('m4a1');
  weaponPivot.add(assembly.group);

  // Camera mounted clear on the upper-right Picatinny rail past the optic housing so the
  // receiver/handguard anchor the lower-left corner while >80% of the viewport stays wide open downrange!
  const cameraAnchor = new THREE.Object3D();
  cameraAnchor.position.set(0.125, 0.104, -0.095);
  cameraAnchor.rotation.set(-0.008, 0.0, 0.024);
  weaponPivot.add(cameraAnchor);

  const flashGeo = new THREE.OctahedronGeometry(0.15, 0);
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffd166,
    transparent: true,
    opacity: 0.94,
  });
  const muzzleFlashMesh = new THREE.Mesh(flashGeo, flashMat);
  muzzleFlashMesh.position.set(0, 0.055, -0.68);
  muzzleFlashMesh.visible = false;
  weaponPivot.add(muzzleFlashMesh);

  const muzzleLight = new THREE.PointLight(0xffb74d, 0, 16, 1.35);
  muzzleLight.position.set(0, 0.06, -0.78);
  weaponPivot.add(muzzleLight);

  const laserGeo = new THREE.CylinderGeometry(0.0018, 0.0018, 18, 6);
  laserGeo.rotateX(Math.PI * 0.5);
  const laserMat = new THREE.MeshBasicMaterial({
    color: 0x34d399,
    transparent: true,
    opacity: 0.22,
  });
  const laserBeam = new THREE.Mesh(laserGeo, laserMat);
  laserBeam.position.set(0.032, 0.072, -9.35);
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

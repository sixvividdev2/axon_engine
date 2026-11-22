import * as THREE from 'three';
import {
  ATTACHMENTS,
  computeDerivedWeaponStats,
  DerivedWeaponStats,
  ForegripPoseStyle,
  resolveReticleColorHex,
  WeaponAttachments,
} from '../../data/attachments';
import {
  createParallaxCollimatedReticleMaterial,
  createScopeLensMaterial,
} from './ScopeLensShader';
import {
  getWeaponPBRMaterialLibrary,
  WeaponModelAssembly,
  WeaponPBRMaterialLibrary,
} from './WeaponModelFactory';

interface MountedAttachmentCache {
  root: THREE.Group;
  mountedGroups: THREE.Group[];
  geos: THREE.BufferGeometry[];
  mats: THREE.Material[];
}

const ASSEMBLY_CACHE_KEY = '__weaponAssemblerCache';

/**
 * Computes a socket's in-battery resting position in `assembly.group` local space,
 * properly accumulating parent offsets (e.g. slideGroup, barrelAssemblyGroup, pumpSlideGroup)
 * while ignoring live blowback/lockback/pump travel offsets so ADS alignment stays exact.
 */
function getSocketRestPosInAssemblyGroup(
  assembly: WeaponModelAssembly,
  socket: THREE.Object3D,
): THREE.Vector3 {
  const pos = socket.position.clone();
  let parent = socket.parent;
  while (parent && parent !== assembly.group) {
    if (parent === assembly.slideOrBolt) {
      pos.x += parent.position.x;
      pos.y += parent.position.y;
      pos.z += assembly.slideBaseZ;
    } else if (parent === assembly.pumpForend) {
      pos.x += parent.position.x;
      pos.y += parent.position.y;
      pos.z += assembly.pumpBaseZ;
    } else {
      pos.add(parent.position);
    }
    parent = parent.parent;
  }
  return pos;
}

function makeCartridge(
  track: <T extends THREE.BufferGeometry>(g: T) => T,
  mats: WeaponPBRMaterialLibrary,
  radius: number,
  length: number,
): THREE.Group {
  const g = new THREE.Group();
  const casing = new THREE.Mesh(
    track(new THREE.CylinderGeometry(radius, radius * 1.04, length * 0.68, 8)),
    mats.brass,
  );
  casing.rotation.x = Math.PI * 0.5;
  casing.position.z = length * 0.14;
  const bullet = new THREE.Mesh(
    track(new THREE.ConeGeometry(radius * 0.92, length * 0.36, 8)),
    mats.bakelite,
  );
  bullet.rotation.x = -Math.PI * 0.5;
  bullet.position.z = -length * 0.34;
  g.add(casing, bullet);
  return g;
}

/**
 * Builds a true hollow cylindrical sleeve / scope ring aligned along the Z axis.
 * Prevents solid cylinder end-caps from ever sitting inside or coplanar with a PiP ocular lens.
 */
function createHollowRingGeo(
  track: <T extends THREE.BufferGeometry>(g: T) => T,
  outerR: number,
  innerR: number,
  lengthZ: number,
  curveSegments = 22,
): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, Math.min(innerR, outerR - 0.0008), 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geo = track(
    new THREE.ExtrudeGeometry(shape, {
      depth: lengthZ,
      bevelEnabled: false,
      curveSegments,
    }),
  );
  geo.translate(0, 0, -lengthZ * 0.5);
  return geo;
}

/**
 * Procedural PBR 3D builder & dynamic re-assembler for modular firearm attachments.
 * Re-computes sightAnchor, leftHandSocket & grip pose, muzzleSocket, flashlight/laser sockets,
 * detachable magazine references, and derived physics ONLY on attach/detach (zero per-frame allocs).
 */
export class WeaponAssembler {
  public static clearAttachments(assembly: WeaponModelAssembly): void {
    const cache = (assembly as unknown as Record<string, MountedAttachmentCache | undefined>)[
      ASSEMBLY_CACHE_KEY
    ];
    if (cache) {
      for (const mg of cache.mountedGroups) {
        if (mg.parent) {
          mg.parent.remove(mg);
        }
      }
      if (cache.root.parent) {
        cache.root.parent.remove(cache.root);
      }
      for (const g of cache.geos) g.dispose();
      for (const m of cache.mats) m.dispose();
      (assembly as unknown as Record<string, MountedAttachmentCache | undefined>)[
        ASSEMBLY_CACHE_KEY
      ] = undefined;
    }

    // Reset sockets & articulated references back to bare firearm defaults
    assembly.sightAnchor.position.copy(assembly.ironSightAnchorPos);
    assembly.objectiveSocket.position.copy(
      getSocketRestPosInAssemblyGroup(assembly, assembly.opticMountSocket),
    );
    assembly.cantSightAnchor.position.copy(
      getSocketRestPosInAssemblyGroup(assembly, assembly.cantOpticMountSocket),
    );
    assembly.cantSightAnchor.rotation.set(0, 0, 0);
    assembly.adsEyeReliefM = assembly.baseAdsEyeReliefM;
    assembly.cantEyeReliefM = 0.22;
    assembly.reticleMaterial = null;
    assembly.scopeLensMaterial = null;
    assembly.hasCantedOptic = false;
    assembly.cantReticleMaterial = null;
    assembly.ocularRadiusM = 0.015;
    assembly.railAdapterGroup = null;
    assembly.opticGroup = null;
    assembly.zoomRingPivot = null;
    assembly.zoomRingSocket = null;
    assembly.elevationTurretMesh = null;
    assembly.suppressor = null;
    assembly.flashlightModule = null;
    assembly.laserModule = null;
    assembly.hasFlashlightAttachment = false;
    assembly.hasLaserAttachment = false;
    assembly.foregripPose = 'none';

    if (assembly.ironSightRearUp) assembly.ironSightRearUp.visible = true;
    if (assembly.ironSightRearFolded) assembly.ironSightRearFolded.visible = false;

    if (assembly.hasLeftHandSocket) {
      assembly.leftHandSocket.position.copy(assembly.baseLeftHandPos);
      assembly.leftHandSocket.rotation.copy(assembly.baseLeftHandRot);
      assembly.leftGripCurl = assembly.baseLeftGripCurl;
    }

    if (assembly.baseMagazine) {
      assembly.baseMagazine.visible = true;
      assembly.magazine = assembly.baseMagazine;
      if (assembly.baseMagazine.parent !== assembly.group) {
        assembly.group.add(assembly.baseMagazine);
      }
      assembly.baseMagazine.position.copy(assembly.magazineHomePos);
      assembly.baseMagazine.quaternion.copy(assembly.magazineHomeQuat);
    }

    assembly.muzzleSocket.position.copy(assembly.muzzleBasePos);
    assembly.muzzleSocket.rotation.set(assembly.zeroElevationRad, 0, 0);
  }

  public static applyAttachments(
    assembly: WeaponModelAssembly,
    baseMassKg: number,
    baseBarrelLengthM: number,
    baseMagCapacity: number,
    attachments?: WeaponAttachments | null,
  ): DerivedWeaponStats {
    this.clearAttachments(assembly);

    const mats = getWeaponPBRMaterialLibrary();
    const geos: THREE.BufferGeometry[] = [];
    const customMats: THREE.Material[] = [];
    const track = <T extends THREE.BufferGeometry>(g: T): T => {
      geos.push(g);
      return g;
    };

    const root = new THREE.Group();
    root.name = 'modular_attachments_root';
    assembly.group.add(root);
    const mountedGroups: THREE.Group[] = [root];

    const cache: MountedAttachmentCache = { root, mountedGroups, geos, mats: customMats };
    (assembly as unknown as Record<string, MountedAttachmentCache | undefined>)[
      ASSEMBLY_CACHE_KEY
    ] = cache;
    assembly.disposeAttachments = () => this.clearAttachments(assembly);

    const isAkStyle =
      assembly.railType === 'dovetail_ak' ||
      assembly.visualStyle === 'carbine_ak' ||
      assembly.visualStyle === 'rifle_ak' ||
      assembly.visualStyle === 'AKStamped' ||
      assembly.visualStyle === 'SovietDMR';
    const isArStyle =
      assembly.visualStyle === 'carbine_ar' ||
      assembly.visualStyle === 'ARCarbine' ||
      assembly.visualStyle === 'PistonCarbine' ||
      assembly.visualStyle === 'AR10_HeavyDMR' ||
      assembly.visualStyle === 'BattleChassisDMR' ||
      assembly.visualStyle === 'PrecisionChassisBolt';
    const isPistolStyle =
      assembly.visualStyle === 'pistol' ||
      assembly.visualStyle === 'ServicePistol' ||
      assembly.visualStyle === 'HeavyMagnumPistol' ||
      assembly.isRevolver;
    const isShotgunStyle =
      assembly.visualStyle === 'shotgun' ||
      assembly.visualStyle === 'TubeShotgun' ||
      assembly.visualStyle === 'HeavyBoreShotgun';
    const isShotgunSaddle = isShotgunStyle && assembly.railType !== 'picatinny_top';
    const isMp5Claw = assembly.railType === 'mp5_claw';
    const isPistolMilled = assembly.railType === 'pistol_milled';

    const magDef = attachments?.magazine ? ATTACHMENTS[attachments.magazine] : undefined;
    const convExtraLenM = magDef?.id.startsWith('conv_') ? (magDef.extraLengthM ?? 0) : 0;

    // -------------------------------------------------------------------------
    // 0. DEDICATED RAIL ADAPTER SLOT (Zenitco B-13 Dovetail Bridge / HK MP5 Claw Rail)
    // -------------------------------------------------------------------------
    const railAdapterId = attachments?.railAdapter;
    const railAdapterDef = railAdapterId ? ATTACHMENTS[railAdapterId] : undefined;
    const hasB13Adapter = railAdapterDef?.id === 'rail_b13_dovetail';
    const hasMp5ClawAdapter = railAdapterDef?.id === 'rail_mp5_claw';
    if (railAdapterDef && railAdapterDef.slot === 'railAdapter') {
      const adapterGroup = new THREE.Group();
      adapterGroup.name = 'mounted_rail_adapter';
      assembly.opticMountSocket.add(adapterGroup);
      mountedGroups.push(adapterGroup);

      if (hasB13Adapter) {
        // Zenitco B-13 CNC-milled AK dovetail side clamp + swept cantilever top Picatinny rail
        const sideClamp = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0075, 0.022, 0.072)),
          mats.gunmetal,
        );
        sideClamp.position.set(-0.022, -0.022, 0.004);
        const qdLever = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.005, 0.007, 0.036)),
          mats.anodized,
        );
        qdLever.position.set(-0.026, -0.025, 0.016);
        const sideArmF = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.006, 0.044, 0.018)),
          mats.anodized,
        );
        sideArmF.position.set(-0.021, -0.002, -0.024);
        const sideArmR = sideArmF.clone();
        sideArmR.position.z = 0.024;
        const sideToTopBridge = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.028, 0.007, 0.088)),
          mats.anodized,
        );
        sideToTopBridge.position.set(-0.010, 0.016, 0.0);
        const picRailTop = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.021, 0.0065, 0.132)),
          mats.anodized,
        );
        picRailTop.position.set(0, 0.0195, -0.004);
        adapterGroup.add(sideClamp, qdLever, sideArmF, sideArmR, sideToTopBridge, picRailTop);
      } else if (hasMp5ClawAdapter) {
        // HK MFI 4-point low-profile claw mount clamping onto MP5 receiver ribs
        const clawBody = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.033, 0.013, 0.104)),
          mats.gunmetal,
        );
        clawBody.position.set(0, 0.002, 0);
        for (const cz of [-0.036, 0.036]) {
          for (const side of [-1, 1]) {
            const lug = new THREE.Mesh(
              track(new THREE.BoxGeometry(0.005, 0.014, 0.012)),
              mats.anodized,
            );
            lug.position.set(side * 0.0165, -0.004, cz);
            adapterGroup.add(lug);
          }
        }
        const clawRail = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.021, 0.0065, 0.106)),
          mats.anodized,
        );
        clawRail.position.set(0, 0.0115, 0);
        adapterGroup.add(clawBody, clawRail);
      }
      assembly.railAdapterGroup = adapterGroup;
    }

    // -------------------------------------------------------------------------
    // 1. OPTIC SLOT (parented directly to opticMountSocket so slide-milled RMRs reciprocate with slideGroup!)
    // -------------------------------------------------------------------------
    const opticId = attachments?.optic;
    const opticDef = opticId ? ATTACHMENTS[opticId] : undefined;
    const primaryReticleHex = resolveReticleColorHex(attachments?.reticleColor, 0xff281b);
    if (opticDef && opticDef.slot === 'optic') {
      const opticMount = new THREE.Group();
      opticMount.name = 'mounted_optic';
      opticMount.position.set(0, 0, 0);
      assembly.opticMountSocket.add(opticMount);
      mountedGroups.push(opticMount);
      const opticRestPos = getSocketRestPosInAssemblyGroup(assembly, assembly.opticMountSocket);

      if (
        assembly.ironSightRearUp &&
        (isArStyle || isPistolMilled || isShotgunStyle || assembly.railType === 'p90_rail')
      ) {
        assembly.ironSightRearUp.visible = false;
      }
      if (assembly.ironSightRearFolded && isArStyle) {
        assembly.ironSightRearFolded.visible = true;
      }

      // Rail interface mounts — only fabricate built-in side clamp if a standalone railAdapter isn't already mounted!
      const isDirectDovetailOptic =
        opticDef.id === 'optic_pso1m2' ||
        opticDef.id === 'optic_pso1_4x' ||
        opticDef.id === 'optic_kobra_rd' ||
        opticDef.id === 'optic_pso4';
      if (isAkStyle && !hasB13Adapter) {
        const sideArm = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0068, 0.052, isDirectDovetailOptic ? 0.058 : 0.062)),
          mats.gunmetal,
        );
        sideArm.position.set(-0.021, -0.008, 0);
        const sideClamp = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0085, 0.014, 0.032)),
          mats.anodized,
        );
        sideClamp.position.set(-0.023, -0.028, 0.006);
        const sideToTopBridge = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.026, 0.007, 0.062)),
          mats.gunmetal,
        );
        sideToTopBridge.position.set(-0.011, 0.015, 0);
        const topBridge = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.023, 0.007, 0.092)),
          mats.anodized,
        );
        topBridge.position.set(0, 0.015, 0);
        opticMount.add(sideArm, sideClamp, sideToTopBridge, topBridge);
      } else if (isMp5Claw && !hasMp5ClawAdapter) {
        const clawBody = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.032, 0.014, 0.092)),
          mats.gunmetal,
        );
        clawBody.position.set(0, 0.002, 0);
        const clawRail = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.021, 0.007, 0.088)),
          mats.anodized,
        );
        clawRail.position.set(0, 0.0115, 0);
        opticMount.add(clawBody, clawRail);
      } else if (isShotgunSaddle) {
        const saddleRail = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.022, 0.006, 0.112)),
          mats.anodized,
        );
        saddleRail.position.set(0, 0.0025, 0);
        opticMount.add(saddleRail);
      } else if (isPistolMilled) {
        const rmrPlate = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.024, 0.003, 0.042)),
          mats.gunmetal,
        );
        rmrPlate.position.set(0, 0.0012, 0);
        opticMount.add(rmrPlate);
      }

      const mountBaseY = hasB13Adapter
        ? 0.0228
        : isAkStyle
          ? 0.0198
          : hasMp5ClawAdapter || isMp5Claw
            ? 0.0162
            : isShotgunSaddle
              ? 0.0068
              : isPistolMilled
                ? 0.0038
                : 0.0012;

      if (opticDef.id === 'optic_rmr_type2' || opticDef.id === 'optic_rmr_micro') {
        // Trijicon RMR Type 2 1x Reflex:
        // Direct milled slide plate on pistols, or skeletonized Picatinny RM33 riser on rifles/shotguns/PDWs
        const usePicRiser = !isPistolMilled && !isPistolStyle;
        const riserH = usePicRiser ? 0.015 : 0;
        if (usePicRiser) {
          const riserBase = new THREE.Mesh(
            track(new THREE.BoxGeometry(0.024, 0.005, 0.046)),
            mats.gunmetal,
          );
          riserBase.position.set(0, mountBaseY + 0.0025, 0);
          const riserPostF = new THREE.Mesh(
            track(new THREE.BoxGeometry(0.018, riserH, 0.010)),
            mats.anodized,
          );
          riserPostF.position.set(0, mountBaseY + 0.004 + riserH * 0.5, -0.013);
          const riserPostR = riserPostF.clone();
          riserPostR.position.z = 0.013;
          opticMount.add(riserBase, riserPostF, riserPostR);
        }
        const rmrBaseY = mountBaseY + riserH;
        const base = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.026, 0.0072, 0.044)),
          mats.anodized,
        );
        base.position.set(0, rmrBaseY + 0.0032, 0);
        // Patented Trijicon owl-ear forged aluminum hood
        const earL = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0038, 0.019, 0.025)),
          mats.anodized,
        );
        earL.position.set(-0.0114, rmrBaseY + 0.013, -0.003);
        const earR = earL.clone();
        earR.position.x = 0.0114;
        const archTop = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0266, 0.0034, 0.023)),
          mats.anodized,
        );
        archTop.position.set(0, rmrBaseY + 0.0218, -0.003);
        // Side brightness +/- membrane buttons
        const btnPlus = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.002, 0.004, 0.005)),
          mats.wornPolymer,
        );
        btnPlus.position.set(-0.0135, rmrBaseY + 0.0045, 0.008);
        const btnMinus = btnPlus.clone();
        btnMinus.position.x = 0.0135;

        const reticleMat = createParallaxCollimatedReticleMaterial({
          mode: 'rmr_dot',
          reticleColorHex: primaryReticleHex,
          coatingTintHex: 0x1a6880,
          brightness: 2.95,
        });
        customMats.push(reticleMat);
        const reticleCenterY = rmrBaseY + 0.0142;
        const glass = new THREE.Mesh(track(new THREE.PlaneGeometry(0.0192, 0.0144)), reticleMat);
        glass.position.set(0, reticleCenterY, -0.004);
        glass.renderOrder = 4;

        opticMount.add(base, earL, earR, archTop, btnPlus, btnMinus, glass);
        assembly.opticGroup = opticMount;
        assembly.reticleMaterial = reticleMat;
        assembly.sightAnchor.position.set(
          opticRestPos.x,
          opticRestPos.y + reticleCenterY,
          opticRestPos.z - 0.004,
        );
      } else if (opticDef.id === 'optic_kobra_rd') {
        const base = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.026, 0.012, 0.068)),
          mats.anodized,
        );
        base.position.set(0, mountBaseY + 0.004, 0.004);
        // Slim recessed rear LED projector deck strictly below the circular lens bottom
        const emitter = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.018, 0.004, 0.018)),
          mats.gunmetal,
        );
        emitter.position.set(0, mountBaseY + 0.0094, 0.022);
        const emitterBezel = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.008, 0.0024, 0.005)),
          mats.anodized,
        );
        emitterBezel.position.set(0, mountBaseY + 0.0102, 0.012);
        // Open U-shaped protective hood & lower cradle around elevated circular lens window
        const reticleCenterY = mountBaseY + 0.0268;
        const hoodBottom = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.031, 0.0034, 0.034)),
          mats.anodized,
        );
        hoodBottom.position.set(0, mountBaseY + 0.010, -0.010);
        const hoodL = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0045, 0.032, 0.034)),
          mats.anodized,
        );
        hoodL.position.set(-0.0155, reticleCenterY, -0.010);
        const hoodR = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0045, 0.032, 0.034)),
          mats.anodized,
        );
        hoodR.position.set(0.0155, reticleCenterY, -0.010);
        const hoodTop = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0355, 0.0045, 0.034)),
          mats.anodized,
        );
        hoodTop.position.set(0, reticleCenterY + 0.016, -0.010);
        const dial = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0055, 0.0055, 0.007, 10)),
          mats.gunmetal,
        );
        dial.rotation.z = Math.PI * 0.5;
        dial.position.set(0.0165, mountBaseY + 0.0068, 0.016);

        const reticleMat = createParallaxCollimatedReticleMaterial({
          mode: 'kobra_chevron',
          reticleColorHex: resolveReticleColorHex(attachments?.reticleColor, 0xff2b1f),
          coatingTintHex: 0x22687e,
          brightness: 2.75,
        });
        customMats.push(reticleMat);
        const glass = new THREE.Mesh(track(new THREE.CircleGeometry(0.0145, 22)), reticleMat);
        glass.position.set(0, reticleCenterY, -0.012);
        glass.renderOrder = 4;

        opticMount.add(
          base,
          emitter,
          emitterBezel,
          hoodBottom,
          hoodL,
          hoodR,
          hoodTop,
          dial,
          glass,
        );
        assembly.opticGroup = opticMount;
        assembly.reticleMaterial = reticleMat;
        assembly.sightAnchor.position.set(
          opticRestPos.x,
          opticRestPos.y + reticleCenterY,
          opticRestPos.z - 0.012,
        );
      } else if (opticDef.id === 'optic_eotech_holo') {
        const qdBase = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.028, 0.012, 0.072)),
          mats.gunmetal,
        );
        qdBase.position.set(0, mountBaseY + 0.004, 0);
        const qdLever = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.006, 0.008, 0.032)),
          mats.anodized,
        );
        qdLever.position.set(-0.017, mountBaseY + 0.004, 0.006);
        // Authentic EXPS3 lowered forward battery deck & transverse CR123A cylinder (matte black anodized, >=1.2mm below glass sill)
        const battDeck = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.029, 0.0062, 0.024)),
          mats.anodized,
        );
        battDeck.position.set(0, mountBaseY + 0.0102, -0.032);
        const battTube = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0048, 0.0048, 0.031, 14)),
          mats.anodized,
        );
        battTube.rotation.z = Math.PI * 0.5;
        battTube.position.set(0, mountBaseY + 0.0085, -0.036);
        const battCapRing = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0052, 0.0052, 0.0038, 12)),
          mats.gunmetal,
        );
        battCapRing.rotation.z = Math.PI * 0.5;
        battCapRing.position.set(0.0165, mountBaseY + 0.0085, -0.036);
        const hoodFloor = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.034, 0.0036, 0.056)),
          mats.anodized,
        );
        hoodFloor.position.set(0, mountBaseY + 0.0114, 0.006);
        const hoodL = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0048, 0.034, 0.056)),
          mats.anodized,
        );
        hoodL.position.set(-0.0165, mountBaseY + 0.027, 0.006);
        const hoodR = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0048, 0.034, 0.056)),
          mats.anodized,
        );
        hoodR.position.set(0.0165, mountBaseY + 0.027, 0.006);
        const hoodTop = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0378, 0.0048, 0.056)),
          mats.anodized,
        );
        hoodTop.position.set(0, mountBaseY + 0.043, 0.006);

        const reticleMat = createParallaxCollimatedReticleMaterial({
          mode: 'eotech_holo',
          reticleColorHex: resolveReticleColorHex(attachments?.reticleColor, 0xff281a),
          coatingTintHex: 0x1c5973,
          brightness: 2.85,
        });
        customMats.push(reticleMat);
        const reticleCenterY = mountBaseY + 0.027;
        const glass = new THREE.Mesh(track(new THREE.PlaneGeometry(0.027, 0.025)), reticleMat);
        glass.position.set(0, reticleCenterY, 0.004);
        glass.renderOrder = 4;

        const frontGlass = new THREE.Mesh(
          track(new THREE.PlaneGeometry(0.027, 0.025)),
          mats.lensGlass,
        );
        frontGlass.position.set(0, reticleCenterY, -0.019);
        frontGlass.renderOrder = 3;

        opticMount.add(
          qdBase,
          qdLever,
          battDeck,
          battTube,
          battCapRing,
          hoodFloor,
          hoodL,
          hoodR,
          hoodTop,
          glass,
          frontGlass,
        );
        assembly.opticGroup = opticMount;
        assembly.reticleMaterial = reticleMat;
        assembly.sightAnchor.position.set(
          opticRestPos.x,
          opticRestPos.y + reticleCenterY,
          opticRestPos.z + 0.004,
        );
      } else if (opticDef.id === 'optic_t2_red_dot') {
        // Aimpoint Micro T-2: Skeletonized QD riser + sealed 20mm anodized tube + side rotary dial
        const qdRiser = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.022, 0.014, 0.044)),
          mats.anodized,
        );
        qdRiser.position.set(0, mountBaseY + 0.005, 0);
        const qdClamp = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.026, 0.006, 0.046)),
          mats.gunmetal,
        );
        qdClamp.position.set(0, mountBaseY + 0.001, 0);

        const tubeCenterY = mountBaseY + 0.024;
        const tubeLen = 0.062;
        const outerR = 0.0138;
        const innerR = 0.0112;
        const tubeShape = new THREE.Shape();
        tubeShape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
        const boreHole = new THREE.Path();
        boreHole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
        tubeShape.holes.push(boreHole);
        const tubeGeo = track(
          new THREE.ExtrudeGeometry(tubeShape, {
            depth: tubeLen,
            bevelEnabled: true,
            bevelThickness: 0.0011,
            bevelSize: 0.0009,
            bevelSegments: 2,
            curveSegments: 18,
          }),
        );
        tubeGeo.translate(0, 0, -tubeLen * 0.5);
        const tubeBody = new THREE.Mesh(tubeGeo, mats.anodized);
        tubeBody.position.set(0, tubeCenterY, 0);

        // Side rotary intensity dial seated cleanly into outer tube wall (inner face > innerR)
        const rheostat = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0064, 0.0068, 0.0085, 12)),
          mats.gunmetal,
        );
        rheostat.rotation.z = Math.PI * 0.5;
        rheostat.position.set(0.017, tubeCenterY - 0.001, 0.006);

        const topCap = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0046, 0.0048, 0.005, 10)),
          mats.gunmetal,
        );
        topCap.position.set(0, tubeCenterY + 0.0155, -0.006);

        const reticleMat = createParallaxCollimatedReticleMaterial({
          mode: 't2_dot',
          reticleColorHex: primaryReticleHex,
          coatingTintHex: 0x165268,
          brightness: 2.95,
        });
        customMats.push(reticleMat);
        const rearGlass = new THREE.Mesh(track(new THREE.CircleGeometry(innerR, 22)), reticleMat);
        rearGlass.position.set(0, tubeCenterY, 0.014);
        rearGlass.renderOrder = 4;

        const frontGlass = new THREE.Mesh(track(new THREE.CircleGeometry(innerR, 18)), mats.lensGlass);
        frontGlass.position.set(0, tubeCenterY, -0.025);
        frontGlass.renderOrder = 3;

        opticMount.add(qdRiser, qdClamp, tubeBody, rheostat, topCap, rearGlass, frontGlass);
        assembly.opticGroup = opticMount;
        assembly.reticleMaterial = reticleMat;
        assembly.sightAnchor.position.set(
          opticRestPos.x,
          opticRestPos.y + tubeCenterY,
          opticRestPos.z + 0.014,
        );
      } else if (opticDef.id === 'optic_pso4') {
        const riser = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.024, 0.014, 0.088)),
          mats.anodized,
        );
        riser.position.set(0, mountBaseY + 0.005, 0.004);
        const scopeCenterY = mountBaseY + 0.025;
        const scopeTubeLen = 0.148;
        const outerR = 0.0174;
        const innerR = 0.0148;
        const ringGeo = createHollowRingGeo(track, 0.0188, outerR + 0.0002, 0.014, 18);
        const ringF = new THREE.Mesh(ringGeo, mats.gunmetal);
        ringF.position.set(0, scopeCenterY, -0.026);
        const ringR = new THREE.Mesh(ringGeo, mats.gunmetal);
        ringR.position.set(0, scopeCenterY, 0.024);

        const tubeShape = new THREE.Shape();
        tubeShape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
        const boreHole = new THREE.Path();
        boreHole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
        tubeShape.holes.push(boreHole);
        const tubeGeo = track(
          new THREE.ExtrudeGeometry(tubeShape, {
            depth: scopeTubeLen,
            bevelEnabled: true,
            bevelThickness: 0.0014,
            bevelSize: 0.0012,
            bevelSegments: 2,
            curveSegments: 20,
          }),
        );
        tubeGeo.translate(0, 0, -scopeTubeLen * 0.5);
        const scopeBody = new THREE.Mesh(tubeGeo, mats.anodized);
        scopeBody.position.set(0, scopeCenterY, 0.004);

        const objGeo = createHollowRingGeo(track, 0.021, 0.0168, 0.036, 20);
        const objBell = new THREE.Mesh(objGeo, mats.gunmetal);
        objBell.position.set(0, scopeCenterY, -0.072);

        const eyecup = new THREE.Mesh(
          track(new THREE.TorusGeometry(0.0168, 0.0032, 8, 20)),
          mats.wornPolymer,
        );
        eyecup.position.set(0, scopeCenterY, 0.081);

        const elevDrum = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0068, 0.0072, 0.010, 12)),
          mats.brass,
        );
        elevDrum.position.set(0, scopeCenterY + 0.020, -0.004);
        const windDrum = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0065, 0.0070, 0.010, 12)),
          mats.brass,
        );
        windDrum.rotation.z = Math.PI * 0.5;
        windDrum.position.set(0.020, scopeCenterY, -0.004);

        const scopeMat = createScopeLensMaterial({
          reticleMode: 'pso_prism',
          reticleColorHex: primaryReticleHex,
          coatingTintHex: 0x1a7254,
        });
        scopeMat.userData.hasIllumination = Boolean(opticDef.hasIlluminatedReticle);
        scopeMat.uniforms.uIlluminated.value = opticDef.hasIlluminatedReticle ? 1.0 : 0.0;
        customMats.push(scopeMat);
        const ocularRadius = 0.0144;
        const reticleGlass = new THREE.Mesh(
          track(new THREE.CircleGeometry(ocularRadius, 28)),
          scopeMat,
        );
        reticleGlass.position.set(0, scopeCenterY, 0.073);
        reticleGlass.renderOrder = 6;

        const objGlass = new THREE.Mesh(
          track(new THREE.CircleGeometry(0.0164, 20)),
          mats.lensGlass,
        );
        objGlass.position.set(0, scopeCenterY, -0.084);
        objGlass.renderOrder = 3;

        opticMount.add(
          riser,
          ringF,
          ringR,
          scopeBody,
          objBell,
          eyecup,
          elevDrum,
          windDrum,
          reticleGlass,
          objGlass,
        );
        assembly.opticGroup = opticMount;
        assembly.elevationTurretMesh = elevDrum;
        assembly.reticleMaterial = scopeMat;
        assembly.scopeLensMaterial = scopeMat;
        assembly.ocularRadiusM = ocularRadius;
        assembly.sightAnchor.position.set(
          opticRestPos.x,
          opticRestPos.y + scopeCenterY,
          opticRestPos.z + 0.073,
        );
        assembly.objectiveSocket.position.set(
          opticRestPos.x,
          opticRestPos.y + scopeCenterY,
          opticRestPos.z - 0.092,
        );
      } else if (opticDef.id === 'optic_razor_1_6' || opticDef.id === 'optic_lpvo_1_6') {
        // Vortex Razor HD Gen II-E 1–6×24 LPVO:
        // 30mm cantilever mount, true HOLLOW tube + HOLLOW rings + HOLLOW rotating magnification ring & throw lever
        // (zero solid cylinder end-caps inside or coplanar with ocular glass -> zero black polygon flicker!)
        const cantileverBase = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.025, 0.011, 0.104)),
          mats.anodized,
        );
        cantileverBase.position.set(0, mountBaseY + 0.0045, -0.004);

        const scopeCenterY = mountBaseY + 0.027;
        const outerR = 0.0176;
        const innerR = 0.0156;
        const mountRingGeo = createHollowRingGeo(track, 0.0194, outerR + 0.0002, 0.016, 20);
        for (const rz of [-0.038, 0.026]) {
          const post = new THREE.Mesh(
            track(new THREE.BoxGeometry(0.017, 0.013, 0.016)),
            mats.anodized,
          );
          post.position.set(0, mountBaseY + 0.011, rz);
          const ringCollar = new THREE.Mesh(mountRingGeo, mats.anodized);
          ringCollar.position.set(0, scopeCenterY, rz);
          opticMount.add(post, ringCollar);
        }

        const tubeLen = 0.176;
        const tubeShape = new THREE.Shape();
        tubeShape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
        const boreHole = new THREE.Path();
        boreHole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
        tubeShape.holes.push(boreHole);
        const tubeGeo = track(
          new THREE.ExtrudeGeometry(tubeShape, {
            depth: tubeLen,
            bevelEnabled: true,
            bevelThickness: 0.0012,
            bevelSize: 0.0010,
            bevelSegments: 2,
            curveSegments: 24,
          }),
        );
        tubeGeo.translate(0, 0, -tubeLen * 0.5);
        // Signature Vortex Stealth Shadow dark bronze-gunmetal tube finish
        const mainTube = new THREE.Mesh(tubeGeo, mats.peqFde);
        mainTube.position.set(0, scopeCenterY, -0.004);

        // Front 24mm hollow objective bell
        const objGeo = createHollowRingGeo(track, 0.0212, 0.0174, 0.046, 22);
        const frontBell = new THREE.Mesh(objGeo, mats.peqFde);
        frontBell.position.set(0, scopeCenterY, -0.106);

        // Rotatable HOLLOW magnification ring + tactile throw lever strictly forward of ocular lens (z = 0.056)
        const zoomRingPivot = new THREE.Group();
        zoomRingPivot.name = 'scope_zoom_ring_pivot';
        zoomRingPivot.position.set(0, scopeCenterY, 0.056);

        const zoomSleeveGeo = createHollowRingGeo(track, 0.0202, outerR + 0.0003, 0.020, 22);
        const zoomRing = new THREE.Mesh(zoomSleeveGeo, mats.anodized);
        zoomRingPivot.add(zoomRing);

        // Knurled tactile ribs around the hollow zoom ring
        for (let i = 0; i < 6; i++) {
          const ang = (i / 6) * Math.PI * 2;
          const rib = new THREE.Mesh(
            track(new THREE.BoxGeometry(0.0022, 0.0024, 0.017)),
            mats.gunmetal,
          );
          rib.position.set(Math.cos(ang) * 0.0204, Math.sin(ang) * 0.0204, 0);
          rib.rotation.z = ang;
          zoomRingPivot.add(rib);
        }

        // Physical throw lever extending radially from upper-left of ring
        const throwLever = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0046, 0.018, 0.0062)),
          mats.anodized,
        );
        throwLever.position.set(-0.017, 0.019, 0);
        throwLever.rotation.z = 0.72;
        const leverTip = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0032, 0.0032, 0.007, 10)),
          mats.gunmetal,
        );
        leverTip.rotation.x = Math.PI * 0.5;
        leverTip.position.set(-0.0235, 0.026, 0);
        zoomRingPivot.add(throwLever, leverTip);

        // IK target socket for left-hand variable zoom ring twist animation
        const zoomRingSocket = new THREE.Object3D();
        zoomRingSocket.name = 'zoomRingSocket';
        zoomRingSocket.position.set(-0.026, 0.024, 0.004);
        zoomRingPivot.add(zoomRingSocket);

        // Rear hollow ocular housing bell & rubber ring cleanly surrounding the PiP glass
        const ocularBellGeo = createHollowRingGeo(track, 0.0205, 0.0156, 0.020, 24);
        const ocularBell = new THREE.Mesh(ocularBellGeo, mats.peqFde);
        ocularBell.position.set(0, scopeCenterY, 0.080);

        const ocularRing = new THREE.Mesh(
          track(new THREE.TorusGeometry(0.0178, 0.0024, 8, 24)),
          mats.wornPolymer,
        );
        ocularRing.position.set(0, scopeCenterY, 0.091);

        // Capped elevation (rotatable for zeroing clicks), windage & side illumination dial
        const elevTurretGroup = new THREE.Group();
        elevTurretGroup.position.set(0, scopeCenterY + 0.021, -0.004);
        const elevCap = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0076, 0.0080, 0.012, 14)),
          mats.anodized,
        );
        const elevIndexTick = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0014, 0.0016, 0.0072)),
          mats.brass,
        );
        elevIndexTick.position.set(0, 0.0062, -0.0028);
        elevTurretGroup.add(elevCap, elevIndexTick);

        const windCap = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0072, 0.0075, 0.011, 12)),
          mats.anodized,
        );
        windCap.rotation.z = Math.PI * 0.5;
        windCap.position.set(0.021, scopeCenterY, -0.004);
        const illumDial = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0072, 0.0072, 0.010, 12)),
          mats.anodized,
        );
        illumDial.rotation.z = Math.PI * 0.5;
        illumDial.position.set(-0.020, scopeCenterY, -0.004);

        const scopeMat = createScopeLensMaterial({
          reticleMode: 'lpvo_mildot',
          reticleColorHex: primaryReticleHex,
          coatingTintHex: 0x1a5a78,
        });
        scopeMat.userData.hasIllumination = Boolean(opticDef.hasIlluminatedReticle);
        scopeMat.uniforms.uIlluminated.value = opticDef.hasIlluminatedReticle ? 1.0 : 0.0;
        customMats.push(scopeMat);
        // Strictly inside ocularBell inner bore (0.0156) and cleanly separated from zoomRing (rear edge at 0.066)
        const ocularRadius = 0.0151;
        const reticleGlass = new THREE.Mesh(
          track(new THREE.CircleGeometry(ocularRadius, 32)),
          scopeMat,
        );
        reticleGlass.position.set(0, scopeCenterY, 0.085);
        reticleGlass.renderOrder = 6;

        const objGlass = new THREE.Mesh(
          track(new THREE.CircleGeometry(0.0170, 20)),
          mats.lensGlass,
        );
        objGlass.position.set(0, scopeCenterY, -0.125);
        objGlass.renderOrder = 3;

        opticMount.add(
          cantileverBase,
          mainTube,
          frontBell,
          zoomRingPivot,
          ocularBell,
          ocularRing,
          elevTurretGroup,
          windCap,
          illumDial,
          reticleGlass,
          objGlass,
        );
        assembly.opticGroup = opticMount;
        assembly.zoomRingPivot = zoomRingPivot;
        assembly.zoomRingSocket = zoomRingSocket;
        assembly.elevationTurretMesh = elevTurretGroup;
        assembly.reticleMaterial = scopeMat;
        assembly.scopeLensMaterial = scopeMat;
        assembly.ocularRadiusM = ocularRadius;
        assembly.sightAnchor.position.set(
          opticRestPos.x,
          opticRestPos.y + scopeCenterY,
          opticRestPos.z + 0.085,
        );
        assembly.objectiveSocket.position.set(
          opticRestPos.x,
          opticRestPos.y + scopeCenterY,
          opticRestPos.z - 0.132,
        );
      } else if (opticDef.id === 'optic_pso1m2' || opticDef.id === 'optic_pso1_4x') {
        // Authentic Soviet PSO-1M2 4×24 Prism Scope:
        // Side-rail dovetail clamp, grey-enamel hollow tube, extendable sunshade, rubber eyecup, amber/red LED battery cap
        const riser = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.022, 0.014, 0.094)),
          mats.gunmetal,
        );
        riser.position.set(0, mountBaseY + 0.005, 0.004);
        const scopeCenterY = mountBaseY + 0.025;
        const scopeTubeLen = 0.188;
        const outerR = 0.0170;
        const innerR = 0.0148;
        const tubeShape = new THREE.Shape();
        tubeShape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
        const boreHole = new THREE.Path();
        boreHole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
        tubeShape.holes.push(boreHole);
        const tubeGeo = track(
          new THREE.ExtrudeGeometry(tubeShape, {
            depth: scopeTubeLen,
            bevelEnabled: true,
            bevelThickness: 0.0013,
            bevelSize: 0.0011,
            bevelSegments: 2,
            curveSegments: 22,
          }),
        );
        tubeGeo.translate(0, 0, -scopeTubeLen * 0.5);
        const scopeBody = new THREE.Mesh(tubeGeo, mats.gunmetal);
        scopeBody.position.set(0, scopeCenterY, -0.008);

        const sunshade = new THREE.Mesh(
          createHollowRingGeo(track, 0.0186, 0.0168, 0.048, 20),
          mats.gunmetal,
        );
        sunshade.position.set(0, scopeCenterY, -0.118);

        // Accordion-style rubber PSO eyecup strictly behind ocular lens (inner bore > ocularRadius)
        const eyecup = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0176, 0.0195, 0.036, 18, 1, true)),
          mats.wornPolymer,
        );
        eyecup.rotation.x = Math.PI * 0.5;
        eyecup.position.set(0, scopeCenterY, 0.104);

        const elevDrumGroup = new THREE.Group();
        elevDrumGroup.position.set(0, scopeCenterY + 0.0195, -0.008);
        const elevDrum = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0072, 0.0076, 0.011, 12)),
          mats.anodized,
        );
        const elevTick = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0014, 0.0015, 0.007)),
          mats.brass,
        );
        elevTick.position.set(0, 0.0058, -0.0026);
        elevDrumGroup.add(elevDrum, elevTick);

        const windDrum = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0068, 0.0072, 0.011, 12)),
          mats.anodized,
        );
        windDrum.rotation.z = Math.PI * 0.5;
        windDrum.position.set(0.0195, scopeCenterY, -0.008);

        // Under-tube AA/3V illumination battery housing + toggle switch
        const battCap = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0058, 0.0058, 0.022, 10)),
          mats.anodized,
        );
        battCap.position.set(-0.012, scopeCenterY - 0.016, 0.028);

        const scopeMat = createScopeLensMaterial({
          reticleMode: 'pso_prism',
          reticleColorHex: resolveReticleColorHex(attachments?.reticleColor, 0xff8c1a),
          coatingTintHex: 0x1a7254,
        });
        scopeMat.userData.hasIllumination = Boolean(opticDef.hasIlluminatedReticle);
        scopeMat.uniforms.uIlluminated.value = opticDef.hasIlluminatedReticle ? 1.0 : 0.0;
        customMats.push(scopeMat);
        const ocularRadius = 0.0144;
        const reticleGlass = new THREE.Mesh(
          track(new THREE.CircleGeometry(ocularRadius, 28)),
          scopeMat,
        );
        reticleGlass.position.set(0, scopeCenterY, 0.082);
        reticleGlass.renderOrder = 6;

        const objGlass = new THREE.Mesh(
          track(new THREE.CircleGeometry(0.0148, 18)),
          mats.lensGlass,
        );
        objGlass.position.set(0, scopeCenterY, -0.104);
        objGlass.renderOrder = 3;

        opticMount.add(
          riser,
          scopeBody,
          sunshade,
          eyecup,
          elevDrumGroup,
          windDrum,
          battCap,
          reticleGlass,
          objGlass,
        );
        assembly.opticGroup = opticMount;
        assembly.elevationTurretMesh = elevDrumGroup;
        assembly.reticleMaterial = scopeMat;
        assembly.scopeLensMaterial = scopeMat;
        assembly.ocularRadiusM = ocularRadius;
        assembly.sightAnchor.position.set(
          opticRestPos.x,
          opticRestPos.y + scopeCenterY,
          opticRestPos.z + 0.082,
        );
        assembly.objectiveSocket.position.set(
          opticRestPos.x,
          opticRestPos.y + scopeCenterY,
          opticRestPos.z - 0.145,
        );
      } else if (opticDef.id === 'optic_nightforce_atacr') {
        // Nightforce ATACR 5-25x56 F1: Hollow dual-ring unimount, 34mm tube, ZeroStop turrets, hollow zoom ring, 56mm bell
        const mountBase = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.028, 0.014, 0.128)),
          mats.anodized,
        );
        mountBase.position.set(0, mountBaseY + 0.005, -0.006);

        const scopeCenterY = mountBaseY + 0.030;
        const outerR = 0.0196;
        const innerR = 0.0176;
        const atacrRingGeo = createHollowRingGeo(track, 0.0216, outerR + 0.0002, 0.020, 20);
        for (const rz of [-0.052, 0.038]) {
          const post = new THREE.Mesh(
            track(new THREE.BoxGeometry(0.020, 0.016, 0.020)),
            mats.anodized,
          );
          post.position.set(0, mountBaseY + 0.013, rz);
          const ringCollar = new THREE.Mesh(atacrRingGeo, mats.anodized);
          ringCollar.position.set(0, scopeCenterY, rz);
          opticMount.add(post, ringCollar);
        }

        const tubeLen = 0.228;
        const tubeShape = new THREE.Shape();
        tubeShape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
        const boreHole = new THREE.Path();
        boreHole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
        tubeShape.holes.push(boreHole);
        const tubeGeo = track(
          new THREE.ExtrudeGeometry(tubeShape, {
            depth: tubeLen,
            bevelEnabled: true,
            bevelThickness: 0.0014,
            bevelSize: 0.0012,
            bevelSegments: 2,
            curveSegments: 22,
          }),
        );
        tubeGeo.translate(0, 0, -tubeLen * 0.5);
        const mainTube = new THREE.Mesh(tubeGeo, mats.anodized);
        mainTube.position.set(0, scopeCenterY, -0.016);

        const objGeo = createHollowRingGeo(track, 0.029, 0.025, 0.088, 22);
        const frontBell = new THREE.Mesh(objGeo, mats.anodized);
        frontBell.position.set(0, scopeCenterY, -0.168);

        // ZeroStop oversized elevation, windage & parallax turrets
        const elevTurretGroup = new THREE.Group();
        elevTurretGroup.position.set(0, scopeCenterY + 0.026, -0.016);
        const elevTurret = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0115, 0.012, 0.018, 16)),
          mats.gunmetal,
        );
        const elevTick = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0018, 0.0018, 0.010)),
          mats.brass,
        );
        elevTick.position.set(0, 0.0094, -0.004);
        elevTurretGroup.add(elevTurret, elevTick);

        const windTurret = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.010, 0.0105, 0.014, 16)),
          mats.gunmetal,
        );
        windTurret.rotation.z = Math.PI * 0.5;
        windTurret.position.set(0.025, scopeCenterY, -0.016);
        const parallaxTurret = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.010, 0.0105, 0.014, 16)),
          mats.gunmetal,
        );
        parallaxTurret.rotation.z = Math.PI * 0.5;
        parallaxTurret.position.set(-0.025, scopeCenterY, -0.016);

        // Hollow zoom ring strictly forward of ocular glass (no solid end-cap flicker)
        const zoomRingPivot = new THREE.Group();
        zoomRingPivot.position.set(0, scopeCenterY, 0.064);
        const zoomRing = new THREE.Mesh(
          createHollowRingGeo(track, 0.0226, outerR + 0.0003, 0.022, 22),
          mats.gunmetal,
        );
        const atacrLever = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0042, 0.014, 0.0055)),
          mats.anodized,
        );
        atacrLever.position.set(-0.019, 0.018, 0);
        atacrLever.rotation.z = 0.7;
        const zoomRingSocket = new THREE.Object3D();
        zoomRingSocket.name = 'zoomRingSocket';
        zoomRingSocket.position.set(-0.025, 0.022, 0.004);
        zoomRingPivot.add(zoomRing, atacrLever, zoomRingSocket);

        const scopeMat = createScopeLensMaterial({
          reticleMode: 'sniper_mildot',
          reticleColorHex: primaryReticleHex,
          coatingTintHex: 0x164a78,
        });
        scopeMat.userData.hasIllumination = Boolean(opticDef.hasIlluminatedReticle);
        scopeMat.uniforms.uIlluminated.value = opticDef.hasIlluminatedReticle ? 1.0 : 0.0;
        customMats.push(scopeMat);
        const ocularRadius = 0.0171;
        const reticleGlass = new THREE.Mesh(
          track(new THREE.CircleGeometry(ocularRadius, 32)),
          scopeMat,
        );
        reticleGlass.position.set(0, scopeCenterY, 0.094);
        reticleGlass.renderOrder = 6;

        const objGlass = new THREE.Mesh(
          track(new THREE.CircleGeometry(0.0245, 22)),
          mats.lensGlass,
        );
        objGlass.position.set(0, scopeCenterY, -0.205);
        objGlass.renderOrder = 3;

        opticMount.add(
          mountBase,
          mainTube,
          frontBell,
          elevTurretGroup,
          windTurret,
          parallaxTurret,
          zoomRingPivot,
          reticleGlass,
          objGlass,
        );
        assembly.opticGroup = opticMount;
        assembly.zoomRingPivot = zoomRingPivot;
        assembly.zoomRingSocket = zoomRingSocket;
        assembly.elevationTurretMesh = elevTurretGroup;
        assembly.reticleMaterial = scopeMat;
        assembly.scopeLensMaterial = scopeMat;
        assembly.ocularRadiusM = ocularRadius;
        assembly.sightAnchor.position.set(
          opticRestPos.x,
          opticRestPos.y + scopeCenterY,
          opticRestPos.z + 0.094,
        );
        assembly.objectiveSocket.position.set(
          opticRestPos.x,
          opticRestPos.y + scopeCenterY,
          opticRestPos.z - 0.215,
        );
      }

      if (opticDef.opticEyeReliefM) {
        assembly.adsEyeReliefM = opticDef.opticEyeReliefM;
      }
      if (opticDef.ocularRadiusM) {
        assembly.ocularRadiusM = opticDef.ocularRadiusM;
      }
    }

    // -------------------------------------------------------------------------
    // 1B. 45° CANTED OFFSET BACKUP OPTIC SLOT (Compact 1x only — no scopes)
    // -------------------------------------------------------------------------
    const cantId = attachments?.canted;
    const cantDef = cantId ? ATTACHMENTS[cantId] : undefined;
    const cantedReticleHex = resolveReticleColorHex(attachments?.cantedReticleColor, 0xff281b);
    if (
      cantDef &&
      cantDef.slot === 'canted' &&
      (cantDef.adsZoomFactor ?? 1) <= 1.2 &&
      !cantDef.hasVariableZoom &&
      !isPistolStyle
    ) {
      const cantRoot = new THREE.Group();
      cantRoot.name = 'mounted_canted_optic';
      cantRoot.position.set(0, 0, 0);
      assembly.cantOpticMountSocket.add(cantRoot);
      mountedGroups.push(cantRoot);
      const cantRestPos = getSocketRestPosInAssemblyGroup(assembly, assembly.cantOpticMountSocket);

      // Rail clamp base + angled 45-degree picatinny offset bracket
      if (isAkStyle) {
        const akClampBridge = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.032, 0.009, 0.044)),
          mats.gunmetal,
        );
        akClampBridge.position.set(-0.012, -0.004, 0);
        cantRoot.add(akClampBridge);
      }

      const baseClamp = new THREE.Mesh(
        track(new THREE.BoxGeometry(0.024, 0.008, 0.042)),
        mats.gunmetal,
      );
      baseClamp.position.set(0.002, 0, 0);
      cantRoot.add(baseClamp);

      // Rotate -45° around Z so local +Y points up-right (1:30 o'clock).
      // Canting weapon +45° around Z brings the optic dead upright directly in front of the eye!
      const cantAngleRad = -Math.PI * 0.25;
      const armPivot = new THREE.Group();
      armPivot.position.set(0.008, 0.002, 0);
      armPivot.rotation.z = cantAngleRad;
      cantRoot.add(armPivot);

      const offsetNeck = new THREE.Mesh(
        track(new THREE.BoxGeometry(0.014, 0.024, 0.032)),
        mats.anodized,
      );
      offsetNeck.position.set(0, 0.012, 0);
      const offsetPad = new THREE.Mesh(
        track(new THREE.BoxGeometry(0.022, 0.006, 0.044)),
        mats.gunmetal,
      );
      offsetPad.position.set(0, 0.025, 0);
      armPivot.add(offsetNeck, offsetPad);

      let localReticleY = 0.040;
      let localReticleZ = 0.005;
      let cantReticleMat: THREE.ShaderMaterial;

      if (cantDef.id === 'canted_eotech_holo') {
        const qd = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.025, 0.008, 0.056)),
          mats.gunmetal,
        );
        qd.position.set(0, 0.031, 0);
        // Lowered matte-black anodized forward battery deck & transverse cap (>=2.0mm below glass sill)
        const battDeck = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.024, 0.005, 0.018)),
          mats.anodized,
        );
        battDeck.position.set(0, 0.0342, -0.022);
        const battTube = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.004, 0.004, 0.026, 12)),
          mats.anodized,
        );
        battTube.rotation.z = Math.PI * 0.5;
        battTube.position.set(0, 0.0327, -0.025);
        const battCapRing = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0043, 0.0043, 0.0032, 10)),
          mats.gunmetal,
        );
        battCapRing.rotation.z = Math.PI * 0.5;
        battCapRing.position.set(0.0138, 0.0327, -0.025);
        const hoodFloor = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.028, 0.003, 0.042)),
          mats.anodized,
        );
        hoodFloor.position.set(0, 0.0365, 0.005);
        localReticleY = 0.049;
        localReticleZ = 0.004;
        const hL = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.004, 0.026, 0.042)),
          mats.anodized,
        );
        hL.position.set(-0.0135, localReticleY, 0.005);
        const hR = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.004, 0.026, 0.042)),
          mats.anodized,
        );
        hR.position.set(0.0135, localReticleY, 0.005);
        const hTop = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.031, 0.004, 0.042)),
          mats.anodized,
        );
        hTop.position.set(0, localReticleY + 0.013, 0.005);

        cantReticleMat = createParallaxCollimatedReticleMaterial({
          mode: 'eotech_holo',
          reticleColorHex: resolveReticleColorHex(attachments?.cantedReticleColor, 0xff281a),
          coatingTintHex: 0x1c5973,
          brightness: 2.85,
        });
        customMats.push(cantReticleMat);

        const glass = new THREE.Mesh(
          track(new THREE.PlaneGeometry(0.022, 0.020)),
          cantReticleMat,
        );
        glass.position.set(0, localReticleY, localReticleZ);
        glass.renderOrder = 4;

        const frontGlass = new THREE.Mesh(
          track(new THREE.PlaneGeometry(0.022, 0.020)),
          mats.lensGlass,
        );
        frontGlass.position.set(0, localReticleY, -0.014);
        frontGlass.renderOrder = 3;

        armPivot.add(
          qd,
          battDeck,
          battTube,
          battCapRing,
          hoodFloor,
          hL,
          hR,
          hTop,
          glass,
          frontGlass,
        );
      } else if (cantDef.id === 'canted_kobra_rd') {
        const base = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.022, 0.009, 0.052)),
          mats.anodized,
        );
        base.position.set(0, 0.031, 0.002);
        // Slim recessed rear emitter deck strictly below elevated lens cradle
        const emitter = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.015, 0.0036, 0.014)),
          mats.gunmetal,
        );
        emitter.position.set(0, 0.0354, 0.016);
        const hoodBottom = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.025, 0.003, 0.026)),
          mats.anodized,
        );
        hoodBottom.position.set(0, 0.036, -0.008);
        localReticleY = 0.0495;
        localReticleZ = -0.009;
        const hL = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0038, 0.025, 0.026)),
          mats.anodized,
        );
        hL.position.set(-0.0125, localReticleY, -0.008);
        const hR = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0038, 0.025, 0.026)),
          mats.anodized,
        );
        hR.position.set(0.0125, localReticleY, -0.008);
        const hTop = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0288, 0.0038, 0.026)),
          mats.anodized,
        );
        hTop.position.set(0, localReticleY + 0.0125, -0.008);

        cantReticleMat = createParallaxCollimatedReticleMaterial({
          mode: 'kobra_chevron',
          reticleColorHex: resolveReticleColorHex(attachments?.cantedReticleColor, 0xff2b1f),
          coatingTintHex: 0x22687e,
          brightness: 2.75,
        });
        customMats.push(cantReticleMat);

        const glass = new THREE.Mesh(
          track(new THREE.CircleGeometry(0.0115, 20)),
          cantReticleMat,
        );
        glass.position.set(0, localReticleY, localReticleZ);
        glass.renderOrder = 4;
        armPivot.add(base, emitter, hoodBottom, hL, hR, hTop, glass);
      } else {
        // Default: Compact Micro T-2 Red Dot on 45° canted mount
        const lowMount = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.020, 0.008, 0.036)),
          mats.anodized,
        );
        lowMount.position.set(0, 0.031, 0);

        const tubeY = 0.043;
        const tubeLen = 0.054;
        const outerR = 0.0124;
        const innerR = 0.0098;
        const tubeShape = new THREE.Shape();
        tubeShape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
        const boreHole = new THREE.Path();
        boreHole.absarc(0, 0, innerR, 0, Math.PI * 2, true);
        tubeShape.holes.push(boreHole);
        const tubeGeo = track(
          new THREE.ExtrudeGeometry(tubeShape, {
            depth: tubeLen,
            bevelEnabled: true,
            bevelThickness: 0.0009,
            bevelSize: 0.0008,
            bevelSegments: 2,
            curveSegments: 16,
          }),
        );
        tubeGeo.translate(0, 0, -tubeLen * 0.5);
        const tubeBody = new THREE.Mesh(tubeGeo, mats.anodized);
        tubeBody.position.set(0, tubeY, 0);

        // Rotary dial seated cleanly outside inner bore radius (inner face > innerR)
        const dial = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0052, 0.0055, 0.0075, 10)),
          mats.gunmetal,
        );
        dial.rotation.z = Math.PI * 0.5;
        dial.position.set(0.0148, tubeY - 0.001, 0.004);

        cantReticleMat = createParallaxCollimatedReticleMaterial({
          mode: 't2_dot',
          reticleColorHex: cantedReticleHex,
          coatingTintHex: 0x165268,
          brightness: 2.95,
        });
        customMats.push(cantReticleMat);
        localReticleY = tubeY;
        localReticleZ = 0.010;

        const rearGlass = new THREE.Mesh(
          track(new THREE.CircleGeometry(innerR, 20)),
          cantReticleMat,
        );
        rearGlass.position.set(0, tubeY, localReticleZ);
        rearGlass.renderOrder = 4;

        const frontGlass = new THREE.Mesh(
          track(new THREE.CircleGeometry(innerR, 16)),
          mats.lensGlass,
        );
        frontGlass.position.set(0, tubeY, -0.022);
        frontGlass.renderOrder = 3;

        armPivot.add(lowMount, tubeBody, dial, rearGlass, frontGlass);
      }

      // Compute exact cantSightAnchor transform in assembly.group space
      const sinC = Math.sin(cantAngleRad);
      const cosC = Math.cos(cantAngleRad);
      const rotX = -localReticleY * sinC;
      const rotY = localReticleY * cosC;
      assembly.cantSightAnchor.position.set(
        cantRestPos.x + armPivot.position.x + rotX,
        cantRestPos.y + armPivot.position.y + rotY,
        cantRestPos.z + localReticleZ,
      );
      assembly.cantSightAnchor.rotation.set(0, 0, cantAngleRad);
      assembly.hasCantedOptic = true;
      assembly.cantReticleMaterial = cantReticleMat;
      assembly.cantEyeReliefM = cantDef.opticEyeReliefM ?? 0.21;
    }

    // -------------------------------------------------------------------------
    // 2. MUZZLE SLOT (parented directly to muzzleMountSocket)
    // -------------------------------------------------------------------------
    const muzzleId = attachments?.muzzle;
    const muzzleDef = muzzleId ? ATTACHMENTS[muzzleId] : undefined;
    let muzzleExtraLenM = convExtraLenM;
    if (muzzleDef && muzzleDef.slot === 'muzzle') {
      const mGroup = new THREE.Group();
      mGroup.name = 'mounted_muzzle';
      mGroup.position.set(0, 0, -convExtraLenM);
      mGroup.userData.homeZ = -convExtraLenM;
      assembly.muzzleMountSocket.add(mGroup);
      mountedGroups.push(mGroup);

      if (muzzleDef.id === 'muzzle_pbs4_545') {
        const rearLock = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.014, 0.0155, 0.028, 12)),
          mats.gunmetal,
        );
        rearLock.rotation.x = Math.PI * 0.5;
        rearLock.position.z = -0.012;
        const coneChamber = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.021, 0.0145, 0.044, 14)),
          mats.anodized,
        );
        coneChamber.rotation.x = Math.PI * 0.5;
        coneChamber.position.z = -0.046;
        const mainCan = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0205, 0.0205, 0.112, 16)),
          mats.gunmetal,
        );
        mainCan.rotation.x = Math.PI * 0.5;
        mainCan.position.z = -0.118;
        const endCap = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0185, 0.0205, 0.012, 14)),
          mats.anodized,
        );
        endCap.rotation.x = Math.PI * 0.5;
        endCap.position.z = -0.178;
        mGroup.add(rearLock, coneChamber, mainCan, endCap);
        assembly.suppressor = mGroup;
      } else if (muzzleDef.id === 'muzzle_338_suppressor') {
        const rearLock = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.017, 0.0185, 0.032, 14)),
          mats.anodized,
        );
        rearLock.rotation.x = Math.PI * 0.5;
        rearLock.position.z = -0.014;
        const mainCan = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0225, 0.0225, 0.182, 18)),
          mats.gunmetal,
        );
        mainCan.rotation.x = Math.PI * 0.5;
        mainCan.position.z = -0.118;
        const endCap = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0195, 0.0225, 0.014, 16)),
          mats.anodized,
        );
        endCap.rotation.x = Math.PI * 0.5;
        endCap.position.z = -0.214;
        mGroup.add(rearLock, mainCan, endCap);
        assembly.suppressor = mGroup;
      } else if (muzzleDef.id === 'muzzle_9mm_suppressor') {
        const piston = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0155, 0.0155, 0.022, 12)),
          mats.chromeSteel,
        );
        piston.rotation.x = Math.PI * 0.5;
        piston.position.z = -0.010;
        const can = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0152, 0.0152, 0.132, 16)),
          mats.anodized,
        );
        can.rotation.x = Math.PI * 0.5;
        can.position.z = -0.084;
        const endCap = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0142, 0.0152, 0.010, 14)),
          mats.gunmetal,
        );
        endCap.rotation.x = Math.PI * 0.5;
        endCap.position.z = -0.154;
        mGroup.add(piston, can, endCap);
        assembly.suppressor = mGroup;
      } else if (muzzleDef.id === 'muzzle_nagant_bramit') {
        const collar = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.013, 0.014, 0.028, 12)),
          mats.bluedSteel,
        );
        collar.rotation.x = Math.PI * 0.5;
        collar.position.z = -0.014;
        const tube = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0145, 0.0145, 0.116, 14)),
          mats.gunmetal,
        );
        tube.rotation.x = Math.PI * 0.5;
        tube.position.z = -0.084;
        mGroup.add(collar, tube);
        assembly.suppressor = mGroup;
      } else if (muzzleDef.id === 'muzzle_salvo_12ga') {
        // Distinctive Rectangular Multi-Rod Baffled Salvo 12 Shotgun Suppressor
        const choke = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.014, 0.014, 0.024, 12)),
          mats.gunmetal,
        );
        choke.rotation.x = Math.PI * 0.5;
        choke.position.z = -0.010;
        const rectBody = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.036, 0.048, 0.184)),
          mats.anodized,
        );
        rectBody.position.set(0, -0.008, -0.112);
        const topRib = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.022, 0.008, 0.178)),
          mats.gunmetal,
        );
        topRib.position.set(0, 0.018, -0.112);
        mGroup.add(choke, rectBody, topRib);
        assembly.suppressor = mGroup;
      } else if (muzzleDef.id === 'muzzle_comp_ak') {
        // DTK-2 multi-baffle slotted AK/Rifle muzzle brake
        const collar = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0135, 0.0135, 0.016, 12)),
          mats.anodized,
        );
        collar.rotation.x = Math.PI * 0.5;
        collar.position.z = -0.008;
        const baffle1 = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.024, 0.022, 0.018)),
          mats.gunmetal,
        );
        baffle1.position.z = -0.024;
        const bridge = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0105, 0.0105, 0.044, 10)),
          mats.anodized,
        );
        bridge.rotation.x = Math.PI * 0.5;
        bridge.position.z = -0.036;
        const baffle2 = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.025, 0.022, 0.016)),
          mats.gunmetal,
        );
        baffle2.position.z = -0.050;
        mGroup.add(collar, baffle1, bridge, baffle2);
      }

      if (muzzleDef.isSuppressor && attachments?.suppressorStowed) {
        mGroup.visible = false;
      } else {
        muzzleExtraLenM += muzzleDef.extraLengthM;
      }
    }

    assembly.muzzleSocket.position.set(
      assembly.muzzleBasePos.x,
      assembly.muzzleBasePos.y,
      assembly.muzzleBasePos.z - muzzleExtraLenM,
    );

    // Recompute zero elevation for updated sightAnchor height-over-bore & extended muzzle
    const heightOverBore = Math.max(
      0,
      assembly.sightAnchor.position.y - assembly.muzzleSocket.position.y,
    );
    const updatedZeroRad =
      assembly.holdClass === 'pistol' ||
      assembly.holdClass === 'rifle' ||
      assembly.holdClass === 'shotgun'
        ? Math.atan2(heightOverBore, 50.0)
        : 0;
    assembly.muzzleSocket.rotation.set(updatedZeroRad, 0, 0);

    // -------------------------------------------------------------------------
    // 3. TACTICAL RAIL SLOT (parented directly to tacticalMountSocket)
    // -------------------------------------------------------------------------
    const tacId = attachments?.tactical;
    const tacDef = tacId ? ATTACHMENTS[tacId] : undefined;
    if (tacDef && tacDef.slot === 'tactical') {
      const tacGroup = new THREE.Group();
      tacGroup.name = 'mounted_tactical';
      tacGroup.position.set(0, 0, 0);
      assembly.tacticalMountSocket.add(tacGroup);
      mountedGroups.push(tacGroup);
      const tacRestPos = getSocketRestPosInAssemblyGroup(assembly, assembly.tacticalMountSocket);

      if (tacDef.id === 'tac_flashlight') {
        if (isPistolStyle) {
          const wmlBody = new THREE.Mesh(
            track(new THREE.BoxGeometry(0.025, 0.018, 0.054)),
            mats.anodized,
          );
          const wmlBezel = new THREE.Mesh(
            track(new THREE.CylinderGeometry(0.0108, 0.0102, 0.024, 12)),
            mats.gunmetal,
          );
          wmlBezel.rotation.x = Math.PI * 0.5;
          wmlBezel.position.set(0, -0.001, -0.032);
          const wmlLens = new THREE.Mesh(
            track(new THREE.CircleGeometry(0.0088, 12)),
            mats.lensGlass,
          );
          wmlLens.position.set(0, -0.001, -0.0445);
          tacGroup.add(wmlBody, wmlBezel, wmlLens);
          assembly.flashlightSocket.setRotationFromEuler(new THREE.Euler(0, 0, 0));
          assembly.flashlightSocket.position.set(
            tacRestPos.x,
            tacRestPos.y - 0.001,
            tacRestPos.z - 0.048,
          );
        } else {
          // Scout-style tactical flashlight clamped flush to barrel clamp (shotgun) or left handguard rail
          const offX = isShotgunStyle ? 0.009 : -0.050;
          const offY = isShotgunStyle ? 0 : -0.002;
          const mountArm = new THREE.Mesh(
            track(new THREE.BoxGeometry(0.016, 0.014, 0.028)),
            mats.gunmetal,
          );
          mountArm.position.set(isShotgunStyle ? 0.004 : -0.044, offY, 0);
          const tube = new THREE.Mesh(
            track(new THREE.CylinderGeometry(0.0095, 0.009, 0.088, 12)),
            mats.anodized,
          );
          tube.rotation.x = Math.PI * 0.5;
          tube.position.set(offX, offY, -0.006);
          const head = new THREE.Mesh(
            track(new THREE.CylinderGeometry(0.0128, 0.0102, 0.024, 12)),
            mats.gunmetal,
          );
          head.rotation.x = Math.PI * 0.5;
          head.position.set(offX, offY, -0.056);
          const lens = new THREE.Mesh(
            track(new THREE.CircleGeometry(0.0105, 12)),
            mats.lensGlass,
          );
          lens.position.set(offX, offY, -0.0685);
          tacGroup.add(mountArm, tube, head, lens);
          assembly.flashlightSocket.position.set(
            tacRestPos.x + offX,
            tacRestPos.y + offY,
            tacRestPos.z - 0.072,
          );
        }
        assembly.flashlightModule = tacGroup;
        assembly.hasFlashlightAttachment = true;
      } else if (tacDef.id === 'tac_laser_red') {
        if (isPistolStyle) {
          const box = new THREE.Mesh(
            track(new THREE.BoxGeometry(0.024, 0.016, 0.048)),
            mats.anodized,
          );
          const diode = new THREE.Mesh(
            track(new THREE.CylinderGeometry(0.0045, 0.0045, 0.012, 10)),
            mats.gunmetal,
          );
          diode.rotation.x = Math.PI * 0.5;
          diode.position.set(0.006, -0.002, -0.026);
          tacGroup.add(box, diode);
          assembly.laserSocket.position.set(
            tacRestPos.x + 0.006,
            tacRestPos.y - 0.002,
            tacRestPos.z - 0.036,
          );
        } else {
          const perst = new THREE.Mesh(
            track(new THREE.BoxGeometry(0.022, 0.020, 0.074)),
            mats.anodized,
          );
          perst.position.set(0.006, 0, 0);
          const emitter = new THREE.Mesh(
            track(new THREE.CylinderGeometry(0.0045, 0.0045, 0.012, 8)),
            mats.gunmetal,
          );
          emitter.rotation.x = Math.PI * 0.5;
          emitter.position.set(0.010, 0.003, -0.040);
          const dial = new THREE.Mesh(
            track(new THREE.CylinderGeometry(0.0052, 0.0052, 0.006, 8)),
            mats.peqFde,
          );
          dial.position.set(0.006, 0.012, 0.010);
          tacGroup.add(perst, emitter, dial);
          assembly.laserSocket.position.set(
            tacRestPos.x + 0.010,
            tacRestPos.y + 0.003,
            tacRestPos.z - 0.048,
          );
        }
        assembly.laserModule = tacGroup;
        assembly.hasLaserAttachment = true;
      } else if (tacDef.id === 'tac_peq_combo') {
        // Right-side FDE AN/PEQ-15 box + Left-side Scout tactical light with left-rail clamp bracket
        const peqMain = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.026, 0.020, 0.084)),
          mats.peqFde,
        );
        peqMain.position.set(0.004, 0.006, 0);
        const peqKnob = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.005, 0.005, 0.006, 8)),
          mats.anodized,
        );
        peqKnob.position.set(0.004, 0.018, 0.014);
        const peqEmitter = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.004, 0.004, 0.008, 8)),
          mats.anodized,
        );
        peqEmitter.rotation.x = Math.PI * 0.5;
        peqEmitter.position.set(0.008, 0.006, -0.044);

        const scoutMount = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.016, 0.014, 0.028)),
          mats.gunmetal,
        );
        scoutMount.position.set(-0.044, -0.004, 0);
        const scoutTube = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0095, 0.009, 0.092, 12)),
          mats.anodized,
        );
        scoutTube.rotation.x = Math.PI * 0.5;
        scoutTube.position.set(-0.050, -0.004, -0.008);
        const scoutHead = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0126, 0.010, 0.024, 12)),
          mats.gunmetal,
        );
        scoutHead.rotation.x = Math.PI * 0.5;
        scoutHead.position.set(-0.050, -0.004, -0.060);
        const scoutLens = new THREE.Mesh(
          track(new THREE.CircleGeometry(0.010, 12)),
          mats.lensGlass,
        );
        scoutLens.position.set(-0.050, -0.004, -0.0725);

        tacGroup.add(peqMain, peqKnob, peqEmitter, scoutMount, scoutTube, scoutHead, scoutLens);
        assembly.laserModule = tacGroup;
        assembly.flashlightModule = tacGroup;
        assembly.hasFlashlightAttachment = true;
        assembly.hasLaserAttachment = true;
        assembly.laserSocket.position.set(
          tacRestPos.x + 0.008,
          tacRestPos.y + 0.006,
          tacRestPos.z - 0.050,
        );
        assembly.flashlightSocket.position.set(
          tacRestPos.x - 0.050,
          tacRestPos.y - 0.004,
          tacRestPos.z - 0.075,
        );
      }
    }

    // -------------------------------------------------------------------------
    // 4. FOREGRIP SLOT (parented directly to foregripMountSocket so pump-mounted foregrips reciprocate!)
    // -------------------------------------------------------------------------
    const gripId = attachments?.foregrip;
    const gripDef = gripId ? ATTACHMENTS[gripId] : undefined;
    if (gripDef && gripDef.slot === 'foregrip') {
      const fgGroup = new THREE.Group();
      fgGroup.name = 'mounted_foregrip';
      fgGroup.position.set(0, 0, 0);
      assembly.foregripMountSocket.add(fgGroup);
      mountedGroups.push(fgGroup);

      if (gripDef.id === 'grip_vertical_rk') {
        const clamp = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.026, 0.014, 0.042)),
          mats.gunmetal,
        );
        clamp.position.set(0, -0.006, 0);
        const shaft = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.014, 0.0155, 0.088, 12)),
          mats.anodized,
        );
        shaft.position.set(0, -0.054, 0);
        // Grip rings for tactile detail
        for (let i = 0; i < 4; i++) {
          const ring = new THREE.Mesh(
            track(new THREE.TorusGeometry(0.015, 0.0018, 6, 12)),
            mats.checkeredGrip,
          );
          ring.rotation.x = Math.PI * 0.5;
          ring.position.set(0, -0.028 - i * 0.018, 0);
          fgGroup.add(ring);
        }
        const cap = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0165, 0.0145, 0.010, 12)),
          mats.gunmetal,
        );
        cap.position.set(0, -0.100, 0);
        fgGroup.add(clamp, shaft, cap);
      } else if (gripDef.id === 'grip_angled_afg') {
        const clamp = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.028, 0.011, 0.112)),
          mats.wornPolymer,
        );
        clamp.position.set(0, -0.005, 0);
        const wedge = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.027, 0.024, 0.084)),
          mats.checkeredGrip,
        );
        wedge.position.set(0, -0.017, -0.004);
        wedge.rotation.x = 0.24;
        const frontStop = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.027, 0.020, 0.016)),
          mats.wornPolymer,
        );
        frontStop.position.set(0, -0.024, -0.046);
        frontStop.rotation.x = -0.35;
        fgGroup.add(clamp, wedge, frontStop);
      }

      assembly.foregripPose = (gripDef.foregripPose ?? 'none') as ForegripPoseStyle;
      if (assembly.hasLeftHandSocket) {
        const off = gripDef.leftHandSocketOffset ?? [0, 0, 0];
        const rOff = gripDef.leftHandRotOffset ?? [0, 0, 0];
        assembly.leftHandSocket.position.set(
          assembly.baseLeftHandPos.x + off[0],
          assembly.baseLeftHandPos.y + off[1],
          assembly.baseLeftHandPos.z + off[2],
        );
        assembly.leftHandSocket.rotation.set(
          assembly.baseLeftHandRot.x + rOff[0],
          assembly.baseLeftHandRot.y + rOff[1],
          assembly.baseLeftHandRot.z + rOff[2],
        );
        assembly.leftGripCurl = gripDef.leftGripCurl ?? assembly.baseLeftGripCurl;
      }
    }

    // -------------------------------------------------------------------------
    // 5. MAGAZINE & CALIBER CONVERSION SLOT
    // -------------------------------------------------------------------------
    if (
      magDef &&
      magDef.slot === 'magazine' &&
      assembly.baseMagazine &&
      !magDef.id.startsWith('conv_')
    ) {
      assembly.baseMagazine.visible = false;
      const customMag = new THREE.Group();
      customMag.position.copy(assembly.magazineHomePos);
      customMag.quaternion.copy(assembly.magazineHomeQuat);

      if (magDef.id === 'mag_pm_12') {
        const body = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0195, 0.078, 0.029)),
          mats.anodized,
        );
        body.position.set(0, 0.004, 0);
        const pad = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0235, 0.008, 0.034)),
          mats.wornPolymer,
        );
        pad.position.set(0, -0.037, 0.001);
        const top = makeCartridge(track, mats, 0.0044, 0.024);
        top.position.set(0, 0.044, -0.001);
        customMag.add(body, pad, top);
      } else if (magDef.id === 'mag_ak_30') {
        const mMat = assembly.visualStyle === 'carbine_ak' ? mats.bakelite : mats.anodized;
        const s1 = new THREE.Mesh(track(new THREE.BoxGeometry(0.0245, 0.068, 0.052)), mMat);
        s1.position.set(0, 0.036, 0.002);
        s1.rotation.x = -0.06;
        const s2 = new THREE.Mesh(track(new THREE.BoxGeometry(0.0245, 0.068, 0.052)), mMat);
        s2.position.set(0, -0.022, -0.009);
        s2.rotation.x = -0.26;
        const s3 = new THREE.Mesh(track(new THREE.BoxGeometry(0.0242, 0.056, 0.051)), mMat);
        s3.position.set(0, -0.072, -0.029);
        s3.rotation.x = -0.45;
        const fp = new THREE.Mesh(track(new THREE.BoxGeometry(0.027, 0.009, 0.056)), mats.gunmetal);
        fp.position.set(0, -0.098, -0.042);
        fp.rotation.x = -0.48;
        const top = makeCartridge(track, mats, 0.0048, 0.042);
        top.position.set(0, 0.072, 0.001);
        customMag.add(s1, s2, s3, fp, top);
      } else if (magDef.id === 'mag_ak_45_bakelite') {
        // Extended curved 45rd RPK-74 marbled bakelite magazine
        const s1 = new THREE.Mesh(track(new THREE.BoxGeometry(0.025, 0.072, 0.052)), mats.bakelite);
        s1.position.set(0, 0.036, 0.002);
        s1.rotation.x = -0.06;
        const s2 = new THREE.Mesh(track(new THREE.BoxGeometry(0.025, 0.074, 0.052)), mats.bakelite);
        s2.position.set(0, -0.026, -0.010);
        s2.rotation.x = -0.24;
        const s3 = new THREE.Mesh(track(new THREE.BoxGeometry(0.0248, 0.074, 0.051)), mats.bakelite);
        s3.position.set(0, -0.088, -0.032);
        s3.rotation.x = -0.42;
        const s4 = new THREE.Mesh(track(new THREE.BoxGeometry(0.0245, 0.064, 0.050)), mats.bakelite);
        s4.position.set(0, -0.144, -0.064);
        s4.rotation.x = -0.58;
        const fp = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.028, 0.010, 0.056)),
          mats.anodized,
        );
        fp.position.set(0, -0.172, -0.084);
        fp.rotation.x = -0.60;
        const top = makeCartridge(track, mats, 0.0048, 0.042);
        top.position.set(0, 0.072, 0.001);
        customMag.add(s1, s2, s3, s4, fp, top);
      } else if (magDef.id === 'mag_m4_60_quad') {
        // Wide quad-stack 60rd casket magazine
        const feedNeck = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0238, 0.066, 0.056)),
          mats.anodized,
        );
        feedNeck.position.set(0, 0.034, 0);
        const casket = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.044, 0.128, 0.064)),
          mats.gunmetal,
        );
        casket.position.set(0, -0.054, -0.008);
        casket.rotation.x = -0.14;
        const witnessSlot = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0455, 0.065, 0.012)),
          mats.brass,
        );
        witnessSlot.position.set(0, -0.048, -0.010);
        witnessSlot.rotation.x = -0.14;
        const floor = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.048, 0.012, 0.068)),
          mats.anodized,
        );
        floor.position.set(0, -0.120, -0.018);
        floor.rotation.x = -0.14;
        const top = makeCartridge(track, mats, 0.0046, 0.044);
        top.position.set(0, 0.068, 0);
        customMag.add(feedNeck, casket, witnessSlot, floor, top);
      } else if (magDef.id === 'mag_ar10_20') {
        const body = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.027, 0.142, 0.076)),
          mats.anodized,
        );
        body.position.set(0, -0.012, 0);
        const fp = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.030, 0.011, 0.080)),
          mats.gunmetal,
        );
        fp.position.set(0, -0.084, 0);
        const top = makeCartridge(track, mats, 0.0058, 0.056);
        top.position.set(0, 0.060, 0);
        customMag.add(body, fp, top);
      } else if (magDef.id === 'mag_saiga_10') {
        const s1 = new THREE.Mesh(track(new THREE.BoxGeometry(0.033, 0.115, 0.084)), mats.wornPolymer);
        s1.position.set(0, 0.004, -0.004);
        s1.rotation.x = -0.08;
        const s2 = new THREE.Mesh(track(new THREE.BoxGeometry(0.033, 0.105, 0.082)), mats.wornPolymer);
        s2.position.set(0, -0.095, -0.024);
        s2.rotation.x = -0.22;
        const fp = new THREE.Mesh(track(new THREE.BoxGeometry(0.036, 0.012, 0.086)), mats.anodized);
        fp.position.set(0, -0.146, -0.036);
        fp.rotation.x = -0.22;
        const shell = new THREE.Mesh(track(new THREE.CylinderGeometry(0.009, 0.009, 0.056, 10)), mats.redShell);
        shell.rotation.x = Math.PI * 0.5;
        shell.position.set(0, 0.064, 0);
        customMag.add(s1, s2, fp, shell);
      }

      root.add(customMag);
      assembly.magazine = customMag;
    }

    // Apply assembly's renderLayer across all socket-parented attachment groups
    for (const mg of mountedGroups) {
      mg.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.layers.set(assembly.renderLayer);
          const isGlass =
            obj.material === mats.lensGlass ||
            obj.material === assembly.reticleMaterial ||
            obj.material === assembly.cantReticleMaterial ||
            obj.material === assembly.scopeLensMaterial;
          obj.castShadow = !isGlass;
          obj.receiveShadow = !isGlass;
        }
      });
    }

    return computeDerivedWeaponStats(
      baseMassKg,
      baseBarrelLengthM,
      baseMagCapacity,
      attachments,
    );
  }
}

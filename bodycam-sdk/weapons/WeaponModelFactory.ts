import * as THREE from 'three';
import { VIEWMODEL_LAYER } from '../BodycamPostProcess';
import {
  BodycamHandSocket,
  BodycamWeaponHoldClass,
  PlatformBuilderStyle,
  WeaponFinishPreset,
  WeaponRailType,
} from '../types';
import {
  getWeaponPBRMaterialLibrary,
  resolveFinishMaterials,
  WeaponPBRMaterialLibrary,
  FinishMaterialSet,
} from './WeaponMaterials';

export { getWeaponPBRMaterialLibrary, resolveFinishMaterials };
export type { WeaponPBRMaterialLibrary, FinishMaterialSet };

export interface WeaponModelBuildSpec {
  id: string;
  holdClass: BodycamWeaponHoldClass;
  barrelLengthM: number;
  visualStyle: PlatformBuilderStyle;
  finish?: WeaponFinishPreset;
  railType?: WeaponRailType;
  isRevolver?: boolean;
  boreAxisHeightM?: number;
  modularCaliberId?: string;
  rightHandSocket: BodycamHandSocket;
  leftHandSocket?: BodycamHandSocket;
  muzzleOffset: [number, number, number];
  laserOffset?: [number, number, number];
  supportsSuppressor?: boolean;
  renderLayer?: number;
}

export interface WeaponModelAssembly {
  readonly group: THREE.Group;
  readonly weaponId: string;
  readonly visualStyle: PlatformBuilderStyle;
  readonly finish: WeaponFinishPreset;
  readonly railType: WeaponRailType;
  readonly isRevolver: boolean;
  readonly holdClass: BodycamWeaponHoldClass;
  readonly renderLayer: number;

  // Exact IK & action sockets
  readonly rightHandSocket: THREE.Object3D;
  readonly leftHandSocket: THREE.Object3D;
  readonly hasLeftHandSocket: boolean;
  leftGripCurl: number;
  readonly muzzleSocket: THREE.Object3D;
  readonly ejectionPortSocket: THREE.Object3D;
  readonly flashlightSocket: THREE.Object3D;
  readonly laserSocket: THREE.Object3D;
  readonly sightAnchor: THREE.Object3D;
  readonly magWellSocket: THREE.Object3D;
  readonly boltRackSocket: THREE.Object3D;

  // Modular attachment mount sockets
  readonly opticMountSocket: THREE.Object3D;
  readonly objectiveSocket: THREE.Object3D;
  readonly cantOpticMountSocket: THREE.Object3D;
  readonly cantSightAnchor: THREE.Object3D;
  readonly muzzleMountSocket: THREE.Object3D;
  readonly tacticalMountSocket: THREE.Object3D;
  readonly foregripMountSocket: THREE.Object3D;

  // Articulated moving weapon components
  readonly slideOrBolt: THREE.Object3D | null;
  readonly slideBaseZ: number;
  readonly slideTravelZ: number;
  readonly chargingHandle: THREE.Object3D | null;
  readonly chargingHandleBaseZ: number;
  readonly boltHandlePivot: THREE.Object3D | null;
  readonly barrelBreakGroup: THREE.Group | null;
  readonly cylinderPivot: THREE.Object3D | null;
  readonly revolverChambers: number;
  readonly hammer: THREE.Object3D | null;
  readonly hammerBaseRotX: number;
  readonly trigger: THREE.Object3D | null;
  readonly triggerBaseRotX: number;
  readonly baseMagazine: THREE.Group | null;
  magazine: THREE.Group | null;
  readonly magazineHomePos: THREE.Vector3;
  readonly magazineHomeQuat: THREE.Quaternion;
  readonly magazineEjectAxis: THREE.Vector3;
  readonly pumpForend: THREE.Object3D | null;
  readonly pumpBaseZ: number;
  suppressor: THREE.Object3D | null;
  flashlightModule: THREE.Object3D | null;
  laserModule: THREE.Object3D | null;
  opticGroup: THREE.Object3D | null;
  reticleMaterial: THREE.ShaderMaterial | null;
  scopeLensMaterial: THREE.ShaderMaterial | null;
  hasCantedOptic: boolean;
  cantReticleMaterial: THREE.ShaderMaterial | null;
  cantEyeReliefM: number;
  ocularRadiusM: number;
  hasFlashlightAttachment: boolean;
  hasLaserAttachment: boolean;
  foregripPose: 'none' | 'vertical' | 'angled';
  readonly pinMesh: THREE.Object3D | null;
  readonly ironSightRearUp: THREE.Object3D | null;
  readonly ironSightRearFolded: THREE.Object3D | null;

  // Calibration metadata
  adsEyeReliefM: number;
  readonly baseAdsEyeReliefM: number;
  readonly ironSightAnchorPos: THREE.Vector3;
  readonly baseLeftHandPos: THREE.Vector3;
  readonly baseLeftHandRot: THREE.Euler;
  readonly baseLeftGripCurl: number;
  readonly muzzleBasePos: THREE.Vector3;
  readonly suppressorExtraLenM: number;
  readonly zeroElevationRad: number;

  // Tracked dynamic attachment cleanup hook
  setSuppressorVisible(visible: boolean): void;
  disposeAttachments?: () => void;
  dispose(): void;
}

export function createParallaxRedDotMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uReticleColor: { value: new THREE.Color(0xff2a1f) },
      uBrightness: { value: 2.6 },
      uLensTint: { value: new THREE.Color(0x1f5a7a) },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vOpticRight;
      varying vec3 vOpticUp;
      varying vec3 vOpticFwd;

      void main() {
        vUv = uv;
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        vOpticRight = normalize((modelMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
        vOpticUp = normalize((modelMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        vOpticFwd = normalize((modelMatrix * vec4(0.0, 0.0, -1.0, 0.0)).xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform vec3 uReticleColor;
      uniform float uBrightness;
      uniform vec3 uLensTint;
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vOpticRight;
      varying vec3 vOpticUp;
      varying vec3 vOpticFwd;

      void main() {
        vec2 lensPos = (vUv - 0.5) * 2.0;
        float lensR = length(lensPos);
        if (lensR > 0.96) discard;
        vec3 rayDir = normalize(vWorldPos - cameraPosition);
        float fwdDot = dot(rayDir, vOpticFwd);
        float frontMask = smoothstep(0.35, 0.72, fwdDot);
        vec2 ang = vec2(dot(rayDir, vOpticRight), dot(rayDir, vOpticUp)) / max(0.25, fwdDot);
        vec2 p = ang * 14.0;
        float r = length(p);
        float coreDot = 1.0 - smoothstep(0.022, 0.042, r);
        float dotHalo = (1.0 - smoothstep(0.03, 0.14, r)) * 0.35;
        float reticle = (coreDot + dotHalo) * frontMask * (1.0 - smoothstep(0.84, 0.95, lensR));
        float edgeSheen = pow(clamp(lensR, 0.0, 1.0), 3.0) * 0.24;
        vec3 finalCol = uLensTint * (0.28 + edgeSheen) + uReticleColor * (reticle * uBrightness);
        float finalAlpha = clamp(0.14 + edgeSheen * 0.45 + reticle * 0.92, 0.0, 1.0);
        gl_FragColor = vec4(finalCol, finalAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function makeBrassTopCartridge(
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

function makeRevolverCylinder(
  track: <T extends THREE.BufferGeometry>(g: T) => T,
  mats: WeaponPBRMaterialLibrary,
  cylMat: THREE.Material,
  radius: number,
  length: number,
  chambers = 6,
  fluted = true,
  hex = false,
): THREE.Group {
  const cylPivot = new THREE.Group();
  const body = new THREE.Mesh(
    track(new THREE.CylinderGeometry(radius, radius, length, hex ? 6 : 16)),
    cylMat,
  );
  body.rotation.x = Math.PI * 0.5;
  cylPivot.add(body);

  const ringRadius = radius * 0.56;
  const caseRadius = radius * 0.21;
  for (let i = 0; i < chambers; i++) {
    const a = (i / chambers) * Math.PI * 2;
    const cx = Math.sin(a) * ringRadius;
    const cy = Math.cos(a) * ringRadius;
    const rim = new THREE.Mesh(
      track(new THREE.CylinderGeometry(caseRadius, caseRadius, 0.004, 8)),
      mats.brass,
    );
    rim.rotation.x = Math.PI * 0.5;
    rim.position.set(cx, cy, length * 0.5 + 0.0008);
    cylPivot.add(rim);

    if (fluted && !hex) {
      const fa = ((i + 0.5) / chambers) * Math.PI * 2;
      const flute = new THREE.Mesh(
        track(new THREE.BoxGeometry(caseRadius * 0.9, caseRadius * 0.9, length * 0.72)),
        mats.anodized,
      );
      flute.position.set(Math.sin(fa) * (radius * 0.95), Math.cos(fa) * (radius * 0.95), -0.002);
      flute.rotation.z = -fa;
      cylPivot.add(flute);
    }
  }
  return cylPivot;
}

export class WeaponModelFactory {
  public static build(
    spec: WeaponModelBuildSpec,
    suppressorAttached = false,
  ): WeaponModelAssembly {
    const mats = getWeaponPBRMaterialLibrary();
    const finish: WeaponFinishPreset = spec.finish ?? 'black_anodized';
    const railType: WeaponRailType = spec.railType ?? 'picatinny_top';
    const isRevolver = Boolean(spec.isRevolver);
    const fin = resolveFinishMaterials(mats, finish);

    const renderLayer = spec.renderLayer ?? VIEWMODEL_LAYER;
    const geos: THREE.BufferGeometry[] = [];
    const customMats: THREE.Material[] = [];

    const track = <T extends THREE.BufferGeometry>(g: T): T => {
      geos.push(g);
      return g;
    };

    const group = new THREE.Group();
    const rightHandSocket = new THREE.Object3D();
    const leftHandSocket = new THREE.Object3D();
    const muzzleSocket = new THREE.Object3D();
    const ejectionPortSocket = new THREE.Object3D();
    const flashlightSocket = new THREE.Object3D();
    const laserSocket = new THREE.Object3D();
    const sightAnchor = new THREE.Object3D();
    const magWellSocket = new THREE.Object3D();
    const boltRackSocket = new THREE.Object3D();

    const opticMountSocket = new THREE.Object3D();
    const objectiveSocket = new THREE.Object3D();
    const cantOpticMountSocket = new THREE.Object3D();
    const cantSightAnchor = new THREE.Object3D();
    const muzzleMountSocket = new THREE.Object3D();
    const tacticalMountSocket = new THREE.Object3D();
    const foregripMountSocket = new THREE.Object3D();

    rightHandSocket.position.set(...spec.rightHandSocket.position);
    rightHandSocket.rotation.set(...spec.rightHandSocket.rotation);

    const hasLeftHandSocket = Boolean(spec.leftHandSocket);
    const baseLeftHandPos = new THREE.Vector3();
    const baseLeftHandRot = new THREE.Euler();
    const baseLeftGripCurl = spec.leftHandSocket?.gripCurl ?? 0.90;
    if (spec.leftHandSocket) {
      leftHandSocket.position.set(...spec.leftHandSocket.position);
      leftHandSocket.rotation.set(...spec.leftHandSocket.rotation);
      baseLeftHandPos.copy(leftHandSocket.position);
      baseLeftHandRot.copy(leftHandSocket.rotation);
    }

    group.add(
      rightHandSocket,
      leftHandSocket,
      muzzleSocket,
      ejectionPortSocket,
      flashlightSocket,
      laserSocket,
      sightAnchor,
      magWellSocket,
      boltRackSocket,
      opticMountSocket,
      objectiveSocket,
      cantOpticMountSocket,
      cantSightAnchor,
      muzzleMountSocket,
      tacticalMountSocket,
      foregripMountSocket,
    );

    let slideOrBolt: THREE.Object3D | null = null;
    let slideBaseZ = 0;
    let slideTravelZ = 0.048;
    let chargingHandle: THREE.Object3D | null = null;
    const chargingHandleBaseZ = 0;
    let boltHandlePivot: THREE.Object3D | null = null;
    let barrelBreakGroup: THREE.Group | null = null;
    let cylinderPivot: THREE.Object3D | null = null;
    let revolverChambers = 6;
    let hammer: THREE.Object3D | null = null;
    const hammerBaseRotX = 0;
    let trigger: THREE.Object3D | null = null;
    const triggerBaseRotX = 0;
    let magazine: THREE.Group | null = null;
    const magazineHomePos = new THREE.Vector3();
    const magazineHomeQuat = new THREE.Quaternion();
    const magazineEjectAxis = new THREE.Vector3(0, -1, 0);
    let pumpForend: THREE.Object3D | null = null;
    let pumpBaseZ = 0;
    const suppressor: THREE.Object3D | null = null;
    const flashlightModule: THREE.Object3D | null = null;
    const laserModule: THREE.Object3D | null = null;
    const opticGroup: THREE.Object3D | null = null;
    const reticleMaterial: THREE.ShaderMaterial | null = null;
    let pinMesh: THREE.Object3D | null = null;
    let ironSightRearUp: THREE.Object3D | null = null;
    let ironSightRearFolded: THREE.Object3D | null = null;

    let adsEyeReliefM = 0.23;
    const ironSightAnchorPos = new THREE.Vector3();
    const muzzleBasePos = new THREE.Vector3(...spec.muzzleOffset);
    let suppressorExtraLenM = 0.16;

    const style = spec.visualStyle;
    const bLen = Math.max(0.10, spec.barrelLengthM);

    // Helper: add trigger + guard
    const addTrigger = (y: number, z: number, guardW = 0.014, guardMat: THREE.Material = mats.anodized) => {
      const tg = new THREE.Mesh(track(new THREE.BoxGeometry(guardW, 0.0045, 0.052)), guardMat);
      tg.position.set(0, y - 0.018, z - 0.004);
      const tgF = new THREE.Mesh(track(new THREE.BoxGeometry(guardW, 0.022, 0.005)), guardMat);
      tgF.position.set(0, y - 0.008, z - 0.028);
      tgF.rotation.x = -0.15;
      group.add(tg, tgF);

      const trigPivot = new THREE.Group();
      trigPivot.position.set(0, y, z);
      const trigBlade = new THREE.Mesh(track(new THREE.BoxGeometry(0.005, 0.020, 0.006)), mats.gunmetal);
      trigBlade.position.set(0, -0.010, -0.003);
      trigBlade.rotation.x = -0.28;
      trigPivot.add(trigBlade);
      group.add(trigPivot);
      trigger = trigPivot;
    };

    // Helper: deployable AR-style flip-up iron sights seated flush on top rail (or barrel band)
    const addFlipUpIrons = (
      railTopY: number,
      rearY: number,
      rearZ: number,
      frontZ: number,
      fiber = false,
      frontOnBarrelY?: number,
    ) => {
      const baseH = 0.008;
      const baseCenterY = railTopY + baseH * 0.5 - 0.0006;
      const wingBotY = railTopY + 0.004;
      const wingTopY = rearY + 0.0085;
      const wingH = Math.max(0.014, wingTopY - wingBotY);
      const wingCenterY = (wingBotY + wingTopY) * 0.5;

      const upGroup = new THREE.Group();
      const rearBase = new THREE.Mesh(track(new THREE.BoxGeometry(0.022, baseH, 0.024)), mats.anodized);
      rearBase.position.set(0, baseCenterY, rearZ);
      const wingL = new THREE.Mesh(track(new THREE.BoxGeometry(0.004, wingH, 0.012)), mats.anodized);
      wingL.position.set(-0.009, wingCenterY, rearZ);
      const wingR = new THREE.Mesh(track(new THREE.BoxGeometry(0.004, wingH, 0.012)), mats.anodized);
      wingR.position.set(0.009, wingCenterY, rearZ);
      const apStemH = Math.max(0.004, rearY - 0.0055 - (railTopY + 0.004));
      const apStem = new THREE.Mesh(track(new THREE.BoxGeometry(0.005, apStemH, 0.006)), mats.gunmetal);
      apStem.position.set(0, railTopY + 0.004 + apStemH * 0.5, rearZ);
      const ap = new THREE.Mesh(track(new THREE.TorusGeometry(0.0056, 0.0017, 8, 14)), mats.gunmetal);
      ap.position.set(0, rearY, rearZ);
      upGroup.add(rearBase, wingL, wingR, apStem, ap);

      if (frontOnBarrelY !== undefined) {
        // Barrel-mounted front sight band + tower connecting bare barrel up to sight line
        const barrelBand = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0138, 0.0142, 0.022, 12)),
          mats.anodized,
        );
        barrelBand.rotation.x = Math.PI * 0.5;
        barrelBand.position.set(0, frontOnBarrelY, frontZ);
        const towerBotY = frontOnBarrelY + 0.008;
        const towerTopY = railTopY + 0.006;
        const towerH = Math.max(0.012, towerTopY - towerBotY);
        const fTower = new THREE.Mesh(track(new THREE.BoxGeometry(0.012, towerH, 0.018)), mats.anodized);
        fTower.position.set(0, (towerBotY + towerTopY) * 0.5, frontZ);
        upGroup.add(barrelBand, fTower);
      } else {
        const fBase = new THREE.Mesh(track(new THREE.BoxGeometry(0.020, baseH, 0.024)), mats.anodized);
        fBase.position.set(0, baseCenterY, frontZ);
        upGroup.add(fBase);
      }

      const fWingL = new THREE.Mesh(track(new THREE.BoxGeometry(0.0038, wingH, 0.012)), mats.anodized);
      fWingL.position.set(-0.0078, wingCenterY, frontZ);
      const fWingR = new THREE.Mesh(track(new THREE.BoxGeometry(0.0038, wingH, 0.012)), mats.anodized);
      fWingR.position.set(0.0078, wingCenterY, frontZ);
      const postBotY = railTopY + 0.004;
      const postTopY = rearY + 0.0015;
      const postH = Math.max(0.008, postTopY - postBotY);
      const fPost = new THREE.Mesh(
        track(new THREE.BoxGeometry(0.0024, postH, 0.0028)),
        fiber ? mats.fiberOrange : mats.tritiumGreen,
      );
      fPost.position.set(0, (postBotY + postTopY) * 0.5, frontZ);
      upGroup.add(fWingL, fWingR, fPost);
      group.add(upGroup);
      ironSightRearUp = upGroup;

      const foldedGroup = new THREE.Group();
      const rf = new THREE.Mesh(track(new THREE.BoxGeometry(0.022, 0.008, 0.024)), mats.anodized);
      rf.position.set(0, railTopY + 0.0034, rearZ);
      foldedGroup.add(rf);
      if (frontOnBarrelY !== undefined) {
        const barrelBandFold = new THREE.Mesh(
          track(new THREE.CylinderGeometry(0.0138, 0.0142, 0.022, 12)),
          mats.anodized,
        );
        barrelBandFold.rotation.x = Math.PI * 0.5;
        barrelBandFold.position.set(0, frontOnBarrelY, frontZ);
        foldedGroup.add(barrelBandFold);
      } else {
        const ff = new THREE.Mesh(track(new THREE.BoxGeometry(0.018, 0.008, 0.024)), mats.anodized);
        ff.position.set(0, railTopY + 0.0034, frontZ);
        foldedGroup.add(ff);
      }
      foldedGroup.visible = false;
      group.add(foldedGroup);
      ironSightRearFolded = foldedGroup;

      ironSightAnchorPos.set(0, rearY, rearZ);
      sightAnchor.position.copy(ironSightAnchorPos);
    };

    // =========================================================================
    // PLATFORM 1: SERVICE & MAGNUM PISTOLS ('pistol' | 'ServicePistol' | 'HeavyMagnumPistol')
    // =========================================================================
    if (style === 'pistol' || style === 'ServicePistol' || style === 'HeavyMagnumPistol') {
      const isDeagle = style === 'HeavyMagnumPistol';
      const isMakarov = spec.id === 'makarov_pm' || spec.id === 'pm_9x19';
      const isM9 = spec.id === 'beretta_m9';
      const isGlock = spec.id === 'glock_17';
      const frameLen = isDeagle ? 0.228 : isMakarov ? 0.145 : 0.174;
      const boreY = spec.boreAxisHeightM ?? (isDeagle ? 0.036 : 0.031);
      adsEyeReliefM = isDeagle ? 0.26 : 0.25;
      muzzleBasePos.set(0, boreY, isDeagle ? -0.246 : isMakarov ? -0.155 : -0.180);
      suppressorExtraLenM = 0.152;

      const frameMat = isDeagle || spec.id === 'jericho_941' ? fin.receiver : mats.wornPolymer;
      const slideMat = isM9 || isDeagle || spec.id === 'jericho_941' ? fin.receiver : mats.gunmetal;

      // Dust cover sized so top seats flush into the slide rails at any boreY
      const dustCoverTopY = Math.max(0.023, boreY - 0.006);
      const dustCoverH = dustCoverTopY - 0.001;
      const dustCover = new THREE.Mesh(
        track(new THREE.BoxGeometry(isDeagle ? 0.033 : 0.027, dustCoverH, frameLen)),
        frameMat,
      );
      dustCover.position.set(0, 0.001 + dustCoverH * 0.5, -frameLen * 0.45);
      group.add(dustCover);

      if (!isMakarov) {
        const railBar = new THREE.Mesh(track(new THREE.BoxGeometry(0.021, 0.005, 0.058)), frameMat);
        railBar.position.set(0, -0.001, -frameLen * 0.74);
        group.add(railBar);
        for (let i = 0; i < 4; i++) {
          const lug = new THREE.Mesh(track(new THREE.BoxGeometry(0.023, 0.003, 0.006)), mats.anodized);
          lug.position.set(0, -0.0035, -frameLen * 0.62 - i * 0.013);
          group.add(lug);
        }
      }

      if (!isGlock) {
        const beaverTail = new THREE.Mesh(track(new THREE.BoxGeometry(0.024, 0.012, 0.022)), frameMat);
        beaverTail.position.set(0, 0.016, 0.016);
        beaverTail.rotation.x = 0.14;
        group.add(beaverTail);
      }

      // Grip
      const gripCore = new THREE.Mesh(
        track(new THREE.BoxGeometry(isDeagle ? 0.032 : 0.026, isDeagle ? 0.106 : 0.094, isDeagle ? 0.048 : 0.040)),
        isMakarov ? mats.bakelite : isDeagle ? mats.checkeredGrip : mats.wornPolymer,
      );
      gripCore.position.set(0, -0.044, -0.002);
      gripCore.rotation.x = 0.23;
      const gripCheckL = new THREE.Mesh(
        track(new THREE.BoxGeometry(0.0035, 0.076, 0.032)),
        isMakarov ? mats.bakelite : mats.checkeredGrip,
      );
      gripCheckL.position.set(-(isDeagle ? 0.016 : 0.0135), -0.044, -0.002);
      gripCheckL.rotation.x = 0.23;
      const gripCheckR = gripCheckL.clone();
      gripCheckR.position.x = isDeagle ? 0.016 : 0.0135;
      group.add(gripCore, gripCheckL, gripCheckR);

      addTrigger(0.001, -0.052, 0.014, frameMat);

      // Barrel
      const barrelLen = isDeagle ? 0.205 : isMakarov ? 0.112 : 0.142;
      const innerBarrel = new THREE.Mesh(
        track(new THREE.CylinderGeometry(isDeagle ? 0.010 : 0.0072, isDeagle ? 0.011 : 0.0076, barrelLen, 12)),
        isM9 ? fin.receiver : mats.chromeSteel,
      );
      innerBarrel.rotation.x = Math.PI * 0.5;
      innerBarrel.position.set(0, boreY, -barrelLen * 0.72);
      const chamberHood = new THREE.Mesh(
        track(new THREE.BoxGeometry(isDeagle ? 0.024 : 0.0165, 0.016, 0.036)),
        mats.chromeSteel,
      );
      chamberHood.position.set(0, boreY + 0.002, -0.056);

      if (!isGlock) {
        const hammerPivot = new THREE.Group();
        hammerPivot.position.set(0, 0.021, 0.015);
        const hSpur = new THREE.Mesh(track(new THREE.BoxGeometry(0.0075, 0.016, 0.012)), slideMat);
        hSpur.position.set(0, 0.007, 0.005);
        hSpur.rotation.x = -0.35;
        hammerPivot.add(hSpur);
        group.add(hammerPivot);
        hammer = hammerPivot;
      }

      let sightDotY: number;
      let rearZ: number;

      if (isDeagle) {
        // Stationary Barrel Assembly: inner barrel, chamber hood, heavy shroud, top Picatinny rail, front sight & optic mount
        const barrelAssemblyGroup = new THREE.Group();
        barrelAssemblyGroup.name = 'barrelAssemblyGroup';
        group.add(barrelAssemblyGroup);

        const shroud = new THREE.Mesh(track(new THREE.BoxGeometry(0.034, 0.034, 0.148)), fin.barrel);
        shroud.position.set(0, boreY + 0.003, -0.172); // top = boreY + 0.020, z = [-0.246, -0.098]
        const ribTopY = boreY + 0.0265;
        const rib = new THREE.Mesh(track(new THREE.BoxGeometry(0.021, 0.007, 0.142)), mats.gunmetal);
        rib.position.set(0, boreY + 0.023, -0.170); // bottom = boreY + 0.0195 (embeds into shroud), top = ribTopY
        barrelAssemblyGroup.add(innerBarrel, chamberHood, shroud, rib);
        for (let i = 0; i < 8; i++) {
          const lug = new THREE.Mesh(track(new THREE.BoxGeometry(0.022, 0.0022, 0.007)), mats.anodized);
          lug.position.set(0, ribTopY - 0.001, -0.108 - i * 0.016);
          barrelAssemblyGroup.add(lug);
        }

        // Front sight seated flush on stationary barrel top rail
        const frontZ = -0.232;
        const fBlade = new THREE.Mesh(track(new THREE.BoxGeometry(0.0036, 0.0075, 0.011)), mats.anodized);
        fBlade.position.set(0, ribTopY + 0.0033, frontZ); // bottom embeds 0.45mm into ribTopY
        const fDot = new THREE.Mesh(track(new THREE.SphereGeometry(0.0016, 6, 6)), mats.tritiumGreen);
        fDot.position.set(0, ribTopY + 0.0043, frontZ + 0.0055);
        barrelAssemblyGroup.add(fBlade, fDot);

        // Stationary top Picatinny optic mount parented directly to barrelAssemblyGroup
        barrelAssemblyGroup.add(opticMountSocket);
        opticMountSocket.position.set(0, ribTopY, -0.155);

        // Reciprocating rear slide + side bridge rails + rear sight
        const slideGroup = new THREE.Group();
        slideGroup.name = 'slideGroup';
        slideBaseZ = 0;
        slideTravelZ = 0.056;
        const slideRear = new THREE.Mesh(track(new THREE.BoxGeometry(0.034, 0.030, 0.096)), fin.receiver);
        slideRear.position.set(0, boreY + 0.003, -0.028); // top = boreY + 0.018, z = [-0.076, +0.020]
        const sRailL = new THREE.Mesh(track(new THREE.BoxGeometry(0.005, 0.016, 0.028)), fin.receiver);
        sRailL.position.set(-0.0145, boreY - 0.004, -0.088);
        const sRailR = sRailL.clone();
        sRailR.position.x = 0.0145;
        slideGroup.add(slideRear, sRailL, sRailR);
        for (let i = 0; i < 6; i++) {
          const ribS = new THREE.Mesh(track(new THREE.BoxGeometry(0.0355, 0.020, 0.0024)), mats.anodized);
          ribS.position.set(0, boreY + 0.002, 0.012 - i * 0.006);
          slideGroup.add(ribS);
        }

        // Rear sight parented to reciprocating slideGroup, level with front sight
        rearZ = -0.004;
        const rearBase = new THREE.Mesh(track(new THREE.BoxGeometry(0.022, 0.009, 0.012)), mats.anodized);
        rearBase.position.set(0, boreY + 0.0220, rearZ); // embeds into slideRear top (boreY + 0.018) up to ribTopY
        const rearL = new THREE.Mesh(track(new THREE.BoxGeometry(0.0054, 0.0075, 0.010)), mats.anodized);
        rearL.position.set(-0.0065, ribTopY + 0.0033, rearZ);
        const rearR = rearL.clone();
        rearR.position.x = 0.0065;
        const dotL = new THREE.Mesh(track(new THREE.SphereGeometry(0.0014, 6, 6)), mats.tritiumGreen);
        dotL.position.set(-0.0065, ribTopY + 0.0043, rearZ + 0.0052);
        const dotR = dotL.clone();
        dotR.position.x = 0.0065;
        slideGroup.add(rearBase, rearL, rearR, dotL, dotR);

        sightDotY = ribTopY + 0.0043;
        group.add(slideGroup);
        slideOrBolt = slideGroup;
      } else {
        // Stationary barrel + chamber on frame
        group.add(innerBarrel, chamberHood);

        // Standard Reciprocating Slide (sights, tritium dots, serrations & milled RMR socket all parented to slideGroup)
        const slideGroup = new THREE.Group();
        slideGroup.name = 'slideGroup';
        slideBaseZ = 0;
        slideTravelZ = 0.044;
        const slideTopY = boreY + 0.0155;
        const sFrontLen = isMakarov ? 0.072 : 0.098;
        const sRear = new THREE.Mesh(track(new THREE.BoxGeometry(0.027, 0.025, 0.056)), slideMat);
        sRear.position.set(0, boreY + 0.003, -0.010); // z = [-0.038, +0.018]
        const sFront = new THREE.Mesh(track(new THREE.BoxGeometry(0.027, 0.025, sFrontLen)), slideMat);
        sFront.position.set(0, boreY + 0.003, -0.074 - sFrontLen * 0.48);
        const sLeft = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0055, isM9 ? 0.012 : 0.025, 0.038)),
          slideMat,
        );
        sLeft.position.set(-0.0108, isM9 ? boreY - 0.003 : boreY + 0.003, -0.056);
        const sRightLower = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.0055, isM9 ? 0.012 : 0.009, 0.038)),
          slideMat,
        );
        sRightLower.position.set(0.0108, isM9 ? boreY - 0.003 : boreY - 0.005, -0.056);
        slideGroup.add(sRear, sFront, sLeft, sRightLower);

        for (let i = 0; i < 6; i++) {
          const ribR = new THREE.Mesh(track(new THREE.BoxGeometry(0.0284, 0.017, 0.0022)), mats.anodized);
          ribR.position.set(0, boreY + 0.002, 0.011 - i * 0.0055);
          ribR.rotation.x = 0.18;
          slideGroup.add(ribR);
        }

        // Rear sight + tritium dots seated flush on slideTopY, parented directly to slideGroup
        rearZ = 0.008;
        const rearSightGroup = new THREE.Group();
        rearSightGroup.name = 'pistolRearSightGroup';
        const rearBase = new THREE.Mesh(track(new THREE.BoxGeometry(0.0185, 0.0024, 0.010)), mats.anodized);
        rearBase.position.set(0, slideTopY + 0.0007, rearZ); // embeds 0.5mm into slideTopY
        const rearL = new THREE.Mesh(track(new THREE.BoxGeometry(0.0052, 0.0068, 0.010)), mats.anodized);
        rearL.position.set(-0.0065, slideTopY + 0.0038, rearZ);
        const rearR = rearL.clone();
        rearR.position.x = 0.0065;
        const dotL = new THREE.Mesh(track(new THREE.SphereGeometry(0.0014, 6, 6)), mats.tritiumGreen);
        dotL.position.set(-0.0065, slideTopY + 0.0046, rearZ + 0.0052);
        const dotR = dotL.clone();
        dotR.position.x = 0.0065;
        rearSightGroup.add(rearBase, rearL, rearR, dotL, dotR);
        slideGroup.add(rearSightGroup);
        if (railType === 'pistol_milled') {
          ironSightRearUp = rearSightGroup;
        }

        // Front sight + tritium dot seated flush on slideTopY, parented directly to slideGroup
        const frontZ = isMakarov ? -0.136 : -0.160;
        const fBlade = new THREE.Mesh(track(new THREE.BoxGeometry(0.0036, 0.0076, 0.011)), mats.anodized);
        fBlade.position.set(0, slideTopY + 0.0034, frontZ); // embeds 0.4mm into slideTopY
        const fDot = new THREE.Mesh(track(new THREE.SphereGeometry(0.0016, 6, 6)), mats.tritiumGreen);
        fDot.position.set(0, slideTopY + 0.0046, frontZ + 0.0055);
        slideGroup.add(fBlade, fDot);

        // Slide-milled RMR optic mount socket parented directly to slideGroup (reciprocates & locks back with slide)
        slideGroup.add(opticMountSocket);
        opticMountSocket.position.set(0, slideTopY, -0.015);

        sightDotY = slideTopY + 0.0046;
        group.add(slideGroup);
        slideOrBolt = slideGroup;
      }

      // Detachable magazine
      const magGroup = new THREE.Group();
      const magBody = new THREE.Mesh(
        track(new THREE.BoxGeometry(isDeagle ? 0.025 : 0.020, 0.088, isDeagle ? 0.036 : 0.030)),
        mats.gunmetal,
      );
      const magBase = new THREE.Mesh(
        track(new THREE.BoxGeometry(isDeagle ? 0.029 : 0.024, 0.010, isDeagle ? 0.042 : 0.035)),
        mats.wornPolymer,
      );
      magBase.position.set(0, -0.047, 0.001);
      const topR = makeBrassTopCartridge(track, mats, isDeagle ? 0.0058 : 0.0044, isDeagle ? 0.032 : 0.024);
      topR.position.set(0, 0.045, -0.001);
      magGroup.add(magBody, magBase, topR);

      magazineHomePos.set(0, -0.048, 0.001);
      magazineHomeQuat.setFromEuler(new THREE.Euler(0.23, 0, 0));
      magazineEjectAxis.set(0, -Math.cos(0.23), Math.sin(0.23)).normalize();
      magGroup.position.copy(magazineHomePos);
      magGroup.quaternion.copy(magazineHomeQuat);
      group.add(magGroup);
      magazine = magGroup;

      ironSightAnchorPos.set(0, sightDotY, rearZ + 0.002);
      sightAnchor.position.copy(ironSightAnchorPos);
      ejectionPortSocket.position.set(0.016, boreY + 0.007, -0.055);
      muzzleMountSocket.position.copy(muzzleBasePos);
      tacticalMountSocket.position.set(0, -0.012, -frameLen * 0.74);
      foregripMountSocket.position.set(0, -0.016, -frameLen * 0.70);
      flashlightSocket.position.set(0, -0.013, muzzleBasePos.z - 0.005);
      laserSocket.position.set(0.010, -0.013, muzzleBasePos.z);
      magWellSocket.position.copy(magazineHomePos);
      boltRackSocket.position.set(-0.018, boreY + 0.005, -0.008);

    // =========================================================================
    // PLATFORM 2: REVOLVERS ('ClassicRevolver' | 'TopBreakRevolver' | 'LowBoreRevolver')
    // =========================================================================
    } else if (style === 'ClassicRevolver' || style === 'TopBreakRevolver' || style === 'LowBoreRevolver') {
      const isRhino = style === 'LowBoreRevolver';
      const isTopBreak = style === 'TopBreakRevolver';
      const isNagant = spec.id === 'nagant_m1895';
      const isPython = spec.id === 'colt_python';
      const isModel29 = spec.id === 'sw_model_29';

      revolverChambers = isNagant ? 7 : 6;
      const cylCenterY = 0.025;
      const boreY = spec.boreAxisHeightM ?? (isRhino ? 0.012 : 0.036);
      const shroudLen = isRhino ? 0.155 : isPython || isModel29 ? 0.155 : 0.118;
      adsEyeReliefM = 0.27;
      muzzleBasePos.set(0, boreY, -0.105 - shroudLen - 0.006);
      suppressorExtraLenM = isNagant ? 0.145 : 0;

      // Grip (angled wood / checkered walnut / Rhino polymer)
      const gripMat = isRhino ? mats.checkeredGrip : mats.walnutWood;
      const grip = new THREE.Mesh(track(new THREE.BoxGeometry(0.026, 0.092, 0.038)), gripMat);
      grip.position.set(0, -0.042, 0.014);
      grip.rotation.x = isRhino ? 0.30 : 0.38;
      const gripCap = new THREE.Mesh(track(new THREE.BoxGeometry(0.028, 0.012, 0.042)), fin.receiver);
      gripCap.position.set(0, -0.084, 0.032);
      gripCap.rotation.x = 0.38;
      group.add(grip, gripCap);

      // Lower frame + recoil shield (stationary on all revolvers)
      const frameBase = new THREE.Mesh(track(new THREE.BoxGeometry(0.024, 0.016, 0.108)), fin.receiver);
      frameBase.position.set(0, -0.005, -0.049);
      const frameRear = new THREE.Mesh(track(new THREE.BoxGeometry(0.024, 0.056, 0.036)), fin.receiver);
      frameRear.position.set(0, 0.026, -0.008); // top = 0.054
      group.add(frameBase, frameRear);

      addTrigger(0.002, -0.038, 0.013, fin.receiver);

      // Exposed Hammer pivoted on its frame pin
      const hPivot = new THREE.Group();
      hPivot.position.set(0, 0.034, 0.010);
      const hSpur = new THREE.Mesh(track(new THREE.BoxGeometry(0.007, 0.015, 0.014)), fin.bolt);
      hSpur.position.set(0, 0.006, 0.006);
      hSpur.rotation.x = -0.35;
      hPivot.add(hSpur);
      group.add(hPivot);
      hammer = hPivot;

      // Revolving cylinder (7 chambers for Nagant M1895, 6 for all others)
      const cylR = isRhino ? 0.020 : isModel29 || isTopBreak ? 0.021 : 0.0185;
      const cyl = makeRevolverCylinder(
        track,
        mats,
        fin.bolt,
        cylR,
        0.044,
        revolverChambers,
        !isRhino,
        isRhino,
      );
      cylinderPivot = cyl;

      // Upper frame components (topStrap clears cylinder top 0.046 with bottom at 0.04675, top at 0.05425)
      const topStrap = new THREE.Mesh(track(new THREE.BoxGeometry(0.018, 0.0075, 0.084)), fin.receiver);
      const frontPost = new THREE.Mesh(track(new THREE.BoxGeometry(0.024, 0.052, 0.020)), fin.receiver);
      const spindlePin = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0038, 0.0038, 0.064, 10)), fin.bolt);
      spindlePin.rotation.x = Math.PI * 0.5;

      let rSightY = 0.0575;
      let rSightZ = -0.016;

      if (isTopBreak) {
        // WEBLEY Mk VI: Hinged barrelBreakGroup pivoting at lower frame knuckle (0, 0.002, -0.098)
        const hingeY = 0.002;
        const hingeZ = -0.098;
        const hingePin = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0055, 0.0055, 0.028, 10)), mats.gunmetal);
        hingePin.rotation.z = Math.PI * 0.5;
        hingePin.position.set(0, hingeY, hingeZ);
        group.add(hingePin);

        const breakGroup = new THREE.Group();
        breakGroup.name = 'barrelBreakGroup';
        breakGroup.position.set(0, hingeY, hingeZ);
        group.add(breakGroup);
        barrelBreakGroup = breakGroup;

        const ly = (wy: number) => wy - hingeY;
        const lz = (wz: number) => wz - hingeZ;

        frontPost.position.set(0, ly(0.027), lz(-0.094));
        topStrap.position.set(0, ly(0.0505), lz(-0.056));
        spindlePin.position.set(0, ly(cylCenterY), lz(-0.066));
        cyl.position.set(0, ly(cylCenterY), lz(-0.056));

        const stirrupLatch = new THREE.Mesh(track(new THREE.BoxGeometry(0.025, 0.012, 0.022)), fin.receiver);
        stirrupLatch.position.set(0, ly(0.052), lz(-0.020)); // top = 0.058

        const barrel = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0088, 0.0096, shroudLen, 12)), fin.barrel);
        barrel.rotation.x = Math.PI * 0.5;
        barrel.position.set(0, ly(boreY), lz(-0.105 - shroudLen * 0.5));
        const ventRib = new THREE.Mesh(track(new THREE.BoxGeometry(0.010, 0.010, shroudLen + 0.004)), fin.barrel);
        ventRib.position.set(0, ly(boreY + 0.012), lz(-0.105 - shroudLen * 0.5)); // top = 0.053
        const underlug = new THREE.Mesh(track(new THREE.BoxGeometry(0.015, 0.016, shroudLen * 0.85)), fin.barrel);
        underlug.position.set(0, ly(boreY - 0.012), lz(-0.105 - shroudLen * 0.42));

        // Rear latch sight + front sight blade both parented cleanly to barrelBreakGroup
        rSightZ = -0.020;
        rSightY = 0.060;
        const rNotchL = new THREE.Mesh(track(new THREE.BoxGeometry(0.0045, 0.006, 0.009)), mats.anodized);
        rNotchL.position.set(-0.0055, ly(0.0595), lz(rSightZ)); // bottom 0.0565 embeds into stirrupLatch top 0.058
        const rNotchR = rNotchL.clone();
        rNotchR.position.x = 0.0055;
        const fRamp = new THREE.Mesh(track(new THREE.BoxGeometry(0.0036, 0.010, 0.014)), mats.anodized);
        fRamp.position.set(0, ly(0.0575), lz(muzzleBasePos.z + 0.014)); // bottom 0.0525 embeds into ventRib top 0.053

        breakGroup.add(
          frontPost,
          topStrap,
          spindlePin,
          cyl,
          stirrupLatch,
          barrel,
          ventRib,
          underlug,
          rNotchL,
          rNotchR,
          fRamp,
        );
      } else {
        // Solid-frame revolvers (Chiappa Rhino, Nagant M1895, S&W Model 10, Colt Python, S&W Model 29)
        frontPost.position.set(0, 0.027, -0.094);
        topStrap.position.set(0, 0.0505, -0.056);
        spindlePin.position.set(0, cylCenterY, -0.064);
        cyl.position.set(0, cylCenterY, -0.056);
        group.add(frontPost, topStrap, spindlePin, cyl);

        if (isRhino) {
          // Low-bore 6-o'clock barrel + slab shroud + flush top & bottom Picatinny rails
          const barrel = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0082, 0.0085, shroudLen, 10)), fin.barrel);
          barrel.rotation.x = Math.PI * 0.5;
          barrel.position.set(0, boreY, -0.105 - shroudLen * 0.5);
          const slab = new THREE.Mesh(track(new THREE.BoxGeometry(0.022, 0.042, shroudLen)), fin.receiver);
          slab.position.set(0, 0.027, -0.105 - shroudLen * 0.5); // y = [0.006, 0.048]
          const topRail = new THREE.Mesh(track(new THREE.BoxGeometry(0.021, 0.006, shroudLen + 0.024)), mats.gunmetal);
          topRail.position.set(0, 0.0505, -0.105 - shroudLen * 0.5 + 0.010); // y = [0.0475, 0.0535]
          const botRail = new THREE.Mesh(track(new THREE.BoxGeometry(0.019, 0.005, 0.072)), mats.gunmetal);
          botRail.position.set(0, 0.004, -0.215); // y = [0.0015, 0.0065]
          group.add(barrel, slab, topRail, botRail);

          rSightZ = -0.018;
          rSightY = 0.0575;
          const rNotchL = new THREE.Mesh(track(new THREE.BoxGeometry(0.0045, 0.0065, 0.009)), mats.anodized);
          rNotchL.position.set(-0.0055, 0.0568, rSightZ); // bottom 0.05355 embeds into topStrap top 0.05425
          const rNotchR = rNotchL.clone();
          rNotchR.position.x = 0.0055;
          const fRamp = new THREE.Mesh(track(new THREE.BoxGeometry(0.0036, 0.007, 0.012)), mats.fiberOrange);
          fRamp.position.set(0, 0.0566, muzzleBasePos.z + 0.016); // bottom 0.0531 embeds into topRail top 0.0535
          group.add(rNotchL, rNotchR, fRamp);
        } else {
          const barrel = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0085, 0.0095, shroudLen, 12)), fin.barrel);
          barrel.rotation.x = Math.PI * 0.5;
          barrel.position.set(0, boreY, -0.105 - shroudLen * 0.5); // top = 0.045
          group.add(barrel);

          if (isPython) {
            // Full-length underlug + ventilated top rib with vertical struts connecting barrel to rib
            const underlug = new THREE.Mesh(track(new THREE.BoxGeometry(0.016, 0.018, shroudLen - 0.006)), fin.barrel);
            underlug.position.set(0, boreY - 0.012, -0.105 - shroudLen * 0.5);
            const ventRib = new THREE.Mesh(track(new THREE.BoxGeometry(0.011, 0.007, shroudLen - 0.004)), fin.barrel);
            ventRib.position.set(0, 0.0505, -0.105 - shroudLen * 0.5); // top = 0.0540
            group.add(underlug, ventRib);
            for (let i = 0; i < 4; i++) {
              const strut = new THREE.Mesh(track(new THREE.BoxGeometry(0.010, 0.007, 0.012)), fin.barrel);
              strut.position.set(0, 0.046, -0.118 - i * 0.042);
              group.add(strut);
            }
          } else if (isNagant) {
            const muzzleCollar = new THREE.Mesh(track(new THREE.CylinderGeometry(0.010, 0.010, 0.016, 10)), mats.gunmetal);
            muzzleCollar.rotation.x = Math.PI * 0.5;
            muzzleCollar.position.set(0, boreY, muzzleBasePos.z + 0.008);
            const ejRod = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0042, 0.0042, shroudLen * 0.60, 8)), fin.barrel);
            ejRod.rotation.x = Math.PI * 0.5;
            ejRod.position.set(0.006, boreY - 0.010, -0.105 - shroudLen * 0.34);
            group.add(muzzleCollar, ejRod);
          } else {
            const ejRod = new THREE.Mesh(track(new THREE.CylinderGeometry(0.005, 0.005, shroudLen * 0.65, 8)), fin.barrel);
            ejRod.rotation.x = Math.PI * 0.5;
            ejRod.position.set(0, boreY - 0.012, -0.105 - shroudLen * 0.34);
            group.add(ejRod);
          }

          // Rear sight flush on topStrap/frameRear top (0.05425)
          rSightZ = -0.016;
          rSightY = 0.0575;
          const rNotchL = new THREE.Mesh(track(new THREE.BoxGeometry(0.0045, 0.006, 0.009)), mats.anodized);
          rNotchL.position.set(-0.0055, 0.0566, rSightZ);
          const rNotchR = rNotchL.clone();
          rNotchR.position.x = 0.0055;
          group.add(rNotchL, rNotchR);

          // Front sight seated flush on ventilated rib (Python) or barrel-mounted ramp base (classic revolvers)
          if (!isPython) {
            const fRampBase = new THREE.Mesh(track(new THREE.BoxGeometry(0.0065, 0.011, 0.022)), fin.barrel);
            fRampBase.position.set(0, 0.0490, muzzleBasePos.z + 0.016); // bottom 0.0435 embeds into barrel top 0.045, top 0.0545
            group.add(fRampBase);
          }
          const fRamp = new THREE.Mesh(
            track(new THREE.BoxGeometry(0.0036, 0.0065, 0.012)),
            isModel29 ? mats.fiberOrange : mats.anodized,
          );
          fRamp.position.set(0, 0.0565, muzzleBasePos.z + 0.014); // embeds into ventRib (0.054) or fRampBase (0.0545)
          group.add(fRamp);
        }
      }

      ironSightAnchorPos.set(0, rSightY, rSightZ);
      sightAnchor.position.copy(ironSightAnchorPos);
      ejectionPortSocket.position.set(0.022, cylCenterY, -0.056);
      opticMountSocket.position.set(0, 0.0535, -0.155);
      muzzleMountSocket.position.copy(muzzleBasePos);
      tacticalMountSocket.position.set(0, -0.007, -0.215);
      flashlightSocket.position.set(0, -0.007, muzzleBasePos.z);
      laserSocket.position.set(0.010, -0.007, muzzleBasePos.z);
      magWellSocket.position.set(0, cylCenterY, -0.056);
      boltRackSocket.position.set(-0.022, cylCenterY, -0.056);

    // =========================================================================
    // PLATFORM 3: AR CARBINES & HEAVY AR-10 DMRs ('ARCarbine' | 'carbine_ar' | 'AR10_HeavyDMR')
    // =========================================================================
    } else if (style === 'ARCarbine' || style === 'carbine_ar' || style === 'AR10_HeavyDMR') {
      const isAr10 = style === 'AR10_HeavyDMR';
      const hgLen = isAr10 ? 0.305 : Math.max(0.195, bLen * 0.28);
      const barrelExpose = Math.max(0.08, bLen * 0.56 - (0.21 + hgLen));
      adsEyeReliefM = 0.22;
      muzzleBasePos.set(0, 0.024, -(0.21 + hgLen + barrelExpose));
      suppressorExtraLenM = isAr10 ? 0.19 : 0.165;

      const upper = new THREE.Mesh(
        track(new THREE.BoxGeometry(isAr10 ? 0.040 : 0.037, 0.035, isAr10 ? 0.228 : 0.205)),
        fin.receiver,
      );
      upper.position.set(0, 0.026, -0.114);
      const lower = new THREE.Mesh(
        track(new THREE.BoxGeometry(isAr10 ? 0.038 : 0.035, 0.038, isAr10 ? 0.198 : 0.175)),
        fin.receiver,
      );
      lower.position.set(0, -0.005, -0.112);
      const magwellLip = new THREE.Mesh(
        track(new THREE.BoxGeometry(0.041, 0.036, isAr10 ? 0.080 : 0.068)),
        fin.receiver,
      );
      magwellLip.position.set(0, -0.016, -0.162);
      const brassDefl = new THREE.Mesh(track(new THREE.BoxGeometry(0.012, 0.016, 0.018)), fin.receiver);
      brassDefl.position.set(0.023, 0.026, -0.064);
      const topRail = new THREE.Mesh(
        track(new THREE.BoxGeometry(0.021, 0.007, 0.205 + hgLen)),
        mats.gunmetal,
      );
      topRail.position.set(0, 0.0465, -(0.01 + (0.205 + hgLen) * 0.5));
      group.add(upper, lower, magwellLip, brassDefl, topRail);

      // Buffer tube & buttstock
      const bufferTube = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0155, 0.0155, 0.205, 12)), fin.receiver);
      bufferTube.rotation.x = Math.PI * 0.5;
      bufferTube.position.set(0, 0.022, 0.095);
      const stockBody = new THREE.Mesh(
        track(new THREE.BoxGeometry(0.040, isAr10 ? 0.098 : 0.088, 0.155)),
        fin.furniture,
      );
      stockBody.position.set(0, isAr10 ? -0.008 : -0.004, 0.168);
      const buttPad = new THREE.Mesh(track(new THREE.BoxGeometry(0.042, 0.104, 0.016)), mats.checkeredGrip);
      buttPad.position.set(0, isAr10 ? -0.010 : -0.006, 0.246);
      group.add(bufferTube, stockBody, buttPad);

      // Grip & Trigger
      const grip = new THREE.Mesh(track(new THREE.BoxGeometry(0.028, 0.098, 0.038)), mats.checkeredGrip);
      grip.position.set(0, -0.056, -0.022);
      grip.rotation.x = 0.28;
      group.add(grip);
      addTrigger(-0.020, -0.064, 0.014, fin.receiver);

      // Reciprocating Bolt Carrier (separate from non-reciprocating AR T-Charging Handle)
      const boltGroup = new THREE.Group();
      boltGroup.name = 'boltCarrierGroup';
      slideBaseZ = 0;
      slideTravelZ = 0.068;
      const bcg = new THREE.Mesh(track(new THREE.BoxGeometry(0.008, 0.015, 0.066)), fin.bolt);
      bcg.position.set(0.018, 0.026, -0.114);
      boltGroup.add(bcg);
      group.add(boltGroup);
      slideOrBolt = boltGroup;

      const chGroup = new THREE.Group();
      chGroup.name = 'chargingHandleGroup';
      const chargeT = new THREE.Mesh(track(new THREE.BoxGeometry(0.044, 0.008, 0.012)), mats.gunmetal);
      chargeT.position.set(0, 0.037, -0.002);
      const chargeStem = new THREE.Mesh(track(new THREE.BoxGeometry(0.010, 0.006, 0.036)), mats.gunmetal);
      chargeStem.position.set(0, 0.037, -0.020);
      chGroup.add(chargeT, chargeStem);
      group.add(chGroup);
      chargingHandle = chGroup;

      // Free-float Handguard + Barrel + Flash Hider
      const hgZ = -0.214 - hgLen * 0.5;
      const hg = new THREE.Mesh(track(new THREE.BoxGeometry(0.044, 0.047, hgLen)), fin.furniture);
      hg.position.set(0, 0.020, hgZ);
      group.add(hg);
      for (let i = 0; i < 5; i++) {
        const slot = new THREE.Mesh(track(new THREE.BoxGeometry(0.0455, 0.008, 0.028)), mats.anodized);
        slot.position.set(0, 0.020, -0.240 - i * (hgLen * 0.175));
        group.add(slot);
      }

      const bMidZ = -(0.214 + hgLen + barrelExpose * 0.5);
      const barrel = new THREE.Mesh(
        track(new THREE.CylinderGeometry(isAr10 ? 0.010 : 0.0086, isAr10 ? 0.0115 : 0.0102, barrelExpose, 12)),
        fin.barrel,
      );
      barrel.rotation.x = Math.PI * 0.5;
      barrel.position.set(0, 0.024, bMidZ);
      const flashHider = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0115, 0.0115, 0.044, 10)), mats.anodized);
      flashHider.rotation.x = Math.PI * 0.5;
      flashHider.position.set(0, 0.024, muzzleBasePos.z + 0.020);
      group.add(barrel, flashHider);

      // Magazine (Straight 20rd 7.62x51 for AR10, curved 30rd PMAG for 5.56)
      const magGroup = new THREE.Group();
      if (isAr10) {
        const mb = new THREE.Mesh(track(new THREE.BoxGeometry(0.026, 0.132, 0.072)), mats.gunmetal);
        mb.position.set(0, -0.010, 0);
        const fp = new THREE.Mesh(track(new THREE.BoxGeometry(0.029, 0.010, 0.076)), mats.anodized);
        fp.position.set(0, -0.078, 0);
        const r762 = makeBrassTopCartridge(track, mats, 0.0058, 0.056);
        r762.position.set(0, 0.058, 0);
        magGroup.add(mb, fp, r762);
      } else {
        const mu = new THREE.Mesh(track(new THREE.BoxGeometry(0.0235, 0.072, 0.056)), mats.wornPolymer);
        mu.position.set(0, 0.032, 0);
        const ml = new THREE.Mesh(track(new THREE.BoxGeometry(0.0235, 0.088, 0.056)), mats.wornPolymer);
        ml.position.set(0, -0.042, -0.008);
        ml.rotation.x = -0.18;
        const mf = new THREE.Mesh(track(new THREE.BoxGeometry(0.0265, 0.010, 0.062)), mats.anodized);
        mf.position.set(0, -0.086, -0.017);
        mf.rotation.x = -0.18;
        const r556 = makeBrassTopCartridge(track, mats, 0.0046, 0.044);
        r556.position.set(0, 0.068, 0);
        magGroup.add(mu, ml, mf, r556);
      }
      magazineHomePos.set(0, -0.082, -0.162);
      magazineHomeQuat.identity();
      magazineEjectAxis.set(0, -1, 0);
      magGroup.position.copy(magazineHomePos);
      group.add(magGroup);
      magazine = magGroup;

      addFlipUpIrons(0.050, 0.072, -0.024, -(0.20 + hgLen));

      ejectionPortSocket.position.set(0.024, 0.027, -0.112);
      opticMountSocket.position.set(0, 0.050, -0.095);
      cantOpticMountSocket.position.set(0.011, 0.050, -0.212);
      cantSightAnchor.position.copy(cantOpticMountSocket.position);
      muzzleMountSocket.position.copy(muzzleBasePos);
      tacticalMountSocket.position.set(0.022, 0.028, hgZ - 0.03);
      foregripMountSocket.position.set(0, -0.0035, hgZ);
      flashlightSocket.position.set(-0.028, 0.022, hgZ - 0.09);
      laserSocket.position.set(0.028, 0.036, hgZ - 0.06);
      magWellSocket.position.copy(magazineHomePos);
      boltRackSocket.position.set(-0.018, 0.038, -0.004);

    // =========================================================================
    // PLATFORM 4: PISTON CARBINES ('PistonCarbine' - HK416, SCAR-L, MCX, SG552)
    // =========================================================================
    } else if (style === 'PistonCarbine') {
      const isScar = spec.id === 'fn_scar_l';
      const isMcx = spec.id === 'sig_mcx';
      const isSg552 = spec.id === 'sig_sg552';
      const hgLen = isSg552 ? 0.148 : 0.210;
      const barrelExpose = Math.max(0.07, bLen * 0.55 - (0.20 + hgLen));
      adsEyeReliefM = 0.22;
      muzzleBasePos.set(0, 0.024, -(0.20 + hgLen + barrelExpose));
      suppressorExtraLenM = 0.165;

      // Monolithic taller piston upper seated flush into continuous top Picatinny rail
      const upper = new THREE.Mesh(
        track(new THREE.BoxGeometry(0.039, isScar ? 0.044 : 0.041, 0.215)),
        fin.receiver,
      );
      upper.position.set(0, 0.029, -0.110); // top = 0.0495..0.0510
      const lower = new THREE.Mesh(track(new THREE.BoxGeometry(0.036, 0.036, 0.175)), fin.receiver);
      lower.position.set(0, -0.004, -0.106);
      const topRail = new THREE.Mesh(
        track(new THREE.BoxGeometry(0.021, 0.007, 0.210 + hgLen)),
        mats.gunmetal,
      );
      topRail.position.set(0, 0.0515, -(0.008 + (0.210 + hgLen) * 0.5)); // bottom = 0.0480, top = 0.0550
      group.add(upper, lower, topRail);

      // Distinctive Stocks
      if (isMcx) {
        const sTop = new THREE.Mesh(track(new THREE.BoxGeometry(0.014, 0.016, 0.195)), fin.receiver);
        sTop.position.set(0, 0.020, 0.108);
        const sPad = new THREE.Mesh(track(new THREE.BoxGeometry(0.026, 0.095, 0.020)), mats.checkeredGrip);
        sPad.position.set(0, -0.010, 0.208);
        group.add(sTop, sPad);
      } else if (isScar) {
        const ugg = new THREE.Mesh(track(new THREE.BoxGeometry(0.038, 0.086, 0.215)), fin.furniture);
        ugg.position.set(0, -0.002, 0.118);
        const pad = new THREE.Mesh(track(new THREE.BoxGeometry(0.040, 0.102, 0.016)), mats.checkeredGrip);
        pad.position.set(0, -0.012, 0.228);
        group.add(ugg, pad);
      } else {
        const tube = new THREE.Mesh(track(new THREE.CylinderGeometry(0.015, 0.015, 0.195, 10)), fin.receiver);
        tube.rotation.x = Math.PI * 0.5;
        tube.position.set(0, 0.020, 0.095);
        const body = new THREE.Mesh(track(new THREE.BoxGeometry(0.036, 0.082, 0.145)), fin.furniture);
        body.position.set(0, -0.004, 0.158);
        group.add(tube, body);
      }

      const grip = new THREE.Mesh(track(new THREE.BoxGeometry(0.028, 0.096, 0.038)), mats.checkeredGrip);
      grip.position.set(0, -0.056, -0.022);
      grip.rotation.x = 0.28;
      group.add(grip);
      addTrigger(-0.020, -0.064, 0.014, fin.receiver);

      // Bolt Carrier + Platform-Accurate Charging Handle:
      // SCAR-L & SG552: reciprocating side charging handle parented to boltCarrierGroup.
      // HK416 & SIG MCX: non-reciprocating rear T-charging handle separated from boltCarrierGroup.
      const boltGroup = new THREE.Group();
      boltGroup.name = 'boltCarrierGroup';
      slideBaseZ = 0;
      slideTravelZ = 0.065;
      const bcg = new THREE.Mesh(track(new THREE.BoxGeometry(0.009, 0.016, 0.064)), fin.bolt);
      bcg.position.set(0.019, 0.028, -0.110);
      boltGroup.add(bcg);
      if (isScar) {
        const sideCharge = new THREE.Mesh(track(new THREE.BoxGeometry(0.024, 0.009, 0.014)), mats.gunmetal);
        sideCharge.position.set(-0.024, 0.034, -0.155);
        boltGroup.add(sideCharge);
        boltRackSocket.position.set(-0.024, 0.034, -0.155);
      } else if (isSg552) {
        const rightCharge = new THREE.Mesh(track(new THREE.BoxGeometry(0.022, 0.009, 0.014)), mats.gunmetal);
        rightCharge.position.set(0.025, 0.030, -0.120);
        boltGroup.add(rightCharge);
        boltRackSocket.position.set(0.028, 0.030, -0.120);
      } else {
        const chGroup = new THREE.Group();
        chGroup.name = 'chargingHandleGroup';
        const chargeT = new THREE.Mesh(track(new THREE.BoxGeometry(0.044, 0.008, 0.012)), mats.gunmetal);
        chargeT.position.set(0, 0.040, 0.002);
        const chargeStem = new THREE.Mesh(track(new THREE.BoxGeometry(0.010, 0.006, 0.036)), mats.gunmetal);
        chargeStem.position.set(0, 0.040, -0.016);
        chGroup.add(chargeT, chargeStem);
        group.add(chGroup);
        chargingHandle = chGroup;
        boltRackSocket.position.set(-0.018, 0.040, 0.002);
      }
      group.add(boltGroup);
      slideOrBolt = boltGroup;

      const hgZ = -0.215 - hgLen * 0.5;
      const hg = new THREE.Mesh(track(new THREE.BoxGeometry(0.044, 0.050, hgLen)), fin.furniture);
      hg.position.set(0, 0.024, hgZ); // top = 0.0490 (embeds into topRail bottom 0.0480), bottom = -0.0010
      const gasBlock = new THREE.Mesh(track(new THREE.BoxGeometry(0.024, 0.034, 0.030)), mats.gunmetal);
      gasBlock.position.set(0, 0.029, -0.215 - hgLen - 0.012);
      const barrel = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0088, 0.0102, barrelExpose, 12)), fin.barrel);
      barrel.rotation.x = Math.PI * 0.5;
      barrel.position.set(0, 0.024, -(0.215 + hgLen + barrelExpose * 0.5));
      const flashHider = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0115, 0.0115, 0.042, 10)), mats.anodized);
      flashHider.rotation.x = Math.PI * 0.5;
      flashHider.position.set(0, 0.024, muzzleBasePos.z + 0.020);
      group.add(hg, gasBlock, barrel, flashHider);

      const magGroup = new THREE.Group();
      const mMat = isSg552 ? mats.translucentSmoke : fin.furniture;
      const mb = new THREE.Mesh(track(new THREE.BoxGeometry(0.024, 0.148, 0.056)), mMat);
      mb.position.set(0, -0.008, -0.004);
      mb.rotation.x = -0.14;
      const mf = new THREE.Mesh(track(new THREE.BoxGeometry(0.027, 0.010, 0.060)), mats.anodized);
      mf.position.set(0, -0.082, -0.014);
      const r556 = makeBrassTopCartridge(track, mats, 0.0046, 0.044);
      r556.position.set(0, 0.066, 0);
      magGroup.add(mb, mf, r556);
      magazineHomePos.set(0, -0.082, -0.155);
      magazineHomeQuat.identity();
      magazineEjectAxis.set(0, -1, 0);
      magGroup.position.copy(magazineHomePos);
      group.add(magGroup);
      magazine = magGroup;

      addFlipUpIrons(0.0550, 0.077, -0.024, -(0.20 + hgLen));

      ejectionPortSocket.position.set(0.024, 0.029, -0.110);
      opticMountSocket.position.set(0, 0.0550, -0.095);
      cantOpticMountSocket.position.set(0.011, 0.0550, -0.212);
      cantSightAnchor.position.copy(cantOpticMountSocket.position);
      muzzleMountSocket.position.copy(muzzleBasePos);
      tacticalMountSocket.position.set(0.022, 0.028, hgZ - 0.03);
      foregripMountSocket.position.set(0, -0.001, hgZ);
      flashlightSocket.position.set(-0.028, 0.022, hgZ - 0.08);
      laserSocket.position.set(0.028, 0.038, hgZ - 0.05);
      magWellSocket.position.copy(magazineHomePos);

    // =========================================================================
    // PLATFORM 5: AK STAMPED SERIES ('AKStamped' | 'carbine_ak' | 'rifle_ak' | 'SovietDMR')
    // =========================================================================
    } else if (style === 'AKStamped' || style === 'carbine_ak' || style === 'rifle_ak' || style === 'SovietDMR') {
      const isSvd = style === 'SovietDMR';
      const isSaiga = spec.id === 'saiga_12';
      const isKrink = style === 'carbine_ak' || spec.id === 'aks74u' || spec.id === 'aks74u_545';
      const isAk105 = spec.id === 'ak105';
      const recvLen = isSvd ? 0.258 : 0.236;
      const hgLen = isSvd ? 0.245 : isKrink ? 0.118 : 0.172;
      const barrelLen = isSvd ? 0.435 : isKrink ? 0.175 : isAk105 ? 0.245 : 0.310;
      adsEyeReliefM = isSvd ? 0.24 : isKrink ? 0.22 : 0.24;
      muzzleBasePos.set(0, 0.022, -(0.228 + barrelLen + (isKrink ? 0.045 : 0.032)));
      suppressorExtraLenM = isSaiga ? 0.205 : 0.165;

      const receiver = new THREE.Mesh(
        track(new THREE.BoxGeometry(isSaiga ? 0.040 : 0.036, 0.054, recvLen)),
        fin.receiver,
      );
      receiver.position.set(0, 0.007, -0.110);
      const dustCover = new THREE.Mesh(
        track(new THREE.CylinderGeometry(0.018, 0.019, recvLen - 0.006, 10, 1, false, -Math.PI * 0.5, Math.PI)),
        mats.anodized,
      );
      dustCover.rotation.x = Math.PI * 0.5;
      dustCover.scale.set(1.0, 1.0, 0.72);
      dustCover.position.set(0, 0.033, -0.110);
      const dovetail = new THREE.Mesh(track(new THREE.BoxGeometry(0.006, 0.018, 0.098)), mats.anodized);
      dovetail.position.set(-0.020, 0.014, -0.088);
      const selector = new THREE.Mesh(track(new THREE.BoxGeometry(0.004, 0.011, 0.095)), mats.anodized);
      selector.position.set(0.0205, 0.014, -0.072);
      selector.rotation.x = -0.10;
      group.add(receiver, dustCover, dovetail, selector);

      const grip = new THREE.Mesh(
        track(new THREE.BoxGeometry(0.027, 0.096, 0.037)),
        isKrink ? mats.bakelite : mats.checkeredGrip,
      );
      grip.position.set(0, -0.058, -0.016);
      grip.rotation.x = 0.30;
      group.add(grip);
      addTrigger(-0.018, -0.048, 0.013, mats.gunmetal);

      // Bolt Carrier + Charging Handle
      const boltGroup = new THREE.Group();
      slideBaseZ = 0;
      slideTravelZ = 0.068;
      const carrier = new THREE.Mesh(track(new THREE.BoxGeometry(0.011, 0.015, 0.082)), fin.bolt);
      carrier.position.set(0.017, 0.024, -0.118);
      const hStem = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0042, 0.0048, 0.024, 8)), fin.bolt);
      hStem.rotation.z = Math.PI * 0.5;
      hStem.position.set(0.028, 0.025, -0.132);
      boltGroup.add(carrier, hStem);
      group.add(boltGroup);
      slideOrBolt = boltGroup;

      // Stock
      if (isKrink) {
        const topS = new THREE.Mesh(track(new THREE.BoxGeometry(0.014, 0.013, 0.215)), mats.gunmetal);
        topS.position.set(0, 0.020, 0.122);
        const botS = new THREE.Mesh(track(new THREE.BoxGeometry(0.014, 0.012, 0.222)), mats.gunmetal);
        botS.position.set(0, -0.024, 0.122);
        botS.rotation.x = 0.22;
        const pad = new THREE.Mesh(track(new THREE.BoxGeometry(0.022, 0.095, 0.014)), mats.wornPolymer);
        pad.position.set(0, -0.018, 0.230);
        group.add(topS, botS, pad);
      } else if (isSvd) {
        // Dragunov SVD skeletal thumbhole walnut stock + cheekrest
        const topBar = new THREE.Mesh(track(new THREE.BoxGeometry(0.028, 0.022, 0.245)), mats.walnutWood);
        topBar.position.set(0, 0.010, 0.128);
        const botBar = new THREE.Mesh(track(new THREE.BoxGeometry(0.026, 0.020, 0.235)), mats.walnutWood);
        botBar.position.set(0, -0.044, 0.125);
        botBar.rotation.x = 0.14;
        const butt = new THREE.Mesh(track(new THREE.BoxGeometry(0.032, 0.092, 0.032)), mats.walnutWood);
        butt.position.set(0, -0.020, 0.245);
        const cheek = new THREE.Mesh(track(new THREE.BoxGeometry(0.032, 0.018, 0.115)), mats.checkeredGrip);
        cheek.position.set(0, 0.026, 0.138);
        group.add(topBar, botBar, butt, cheek);
      } else {
        const sMat = isAk105 || isSaiga ? mats.wornPolymer : mats.laminatedWood;
        const stockBody = new THREE.Mesh(track(new THREE.BoxGeometry(0.031, 0.078, 0.225)), sMat);
        stockBody.position.set(0, -0.010, 0.118);
        stockBody.rotation.x = 0.09;
        const pad = new THREE.Mesh(track(new THREE.BoxGeometry(0.032, 0.088, 0.012)), mats.gunmetal);
        pad.position.set(0, -0.020, 0.232);
        group.add(stockBody, pad);
      }

      // Handguard + Barrel
      const hgMat = isSvd ? mats.walnutWood : isAk105 || isSaiga ? mats.wornPolymer : mats.laminatedWood;
      const hgZ = -0.228 - hgLen * 0.5;
      const lowerHg = new THREE.Mesh(track(new THREE.BoxGeometry(0.042, 0.032, hgLen)), hgMat);
      lowerHg.position.set(0, 0.002, hgZ);
      const upperHg = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0165, 0.0175, hgLen - 0.01, 10)), hgMat);
      upperHg.rotation.x = Math.PI * 0.5;
      upperHg.position.set(0, 0.032, hgZ);
      const barrel = new THREE.Mesh(
        track(new THREE.CylinderGeometry(isSaiga ? 0.0125 : 0.0085, isSaiga ? 0.0135 : 0.0105, barrelLen, 12)),
        fin.barrel,
      );
      barrel.rotation.x = Math.PI * 0.5;
      barrel.position.set(0, 0.022, -0.228 - barrelLen * 0.5);
      const gasTube = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0072, 0.0078, hgLen + 0.03, 10)), fin.barrel);
      gasTube.rotation.x = Math.PI * 0.5;
      gasTube.position.set(0, 0.037, hgZ - 0.01);
      const muzzleDev = new THREE.Mesh(
        track(new THREE.CylinderGeometry(isKrink ? 0.018 : 0.011, 0.011, 0.038, 12)),
        mats.anodized,
      );
      muzzleDev.rotation.x = Math.PI * 0.5;
      muzzleDev.position.set(0, 0.022, muzzleBasePos.z + 0.018);
      group.add(lowerHg, upperHg, barrel, gasTube, muzzleDev);

      // Magazine
      const magGroup = new THREE.Group();
      if (isSaiga) {
        const sb = new THREE.Mesh(track(new THREE.BoxGeometry(0.032, 0.145, 0.082)), mats.wornPolymer);
        sb.position.set(0, -0.012, -0.006);
        sb.rotation.x = -0.10;
        const r12 = new THREE.Mesh(track(new THREE.CylinderGeometry(0.009, 0.009, 0.056, 10)), mats.redShell);
        r12.rotation.x = Math.PI * 0.5;
        r12.position.set(0, 0.062, 0);
        magGroup.add(sb, r12);
      } else if (isSvd) {
        const mb = new THREE.Mesh(track(new THREE.BoxGeometry(0.025, 0.098, 0.082)), mats.gunmetal);
        mb.position.set(0, 0.004, 0);
        mb.rotation.x = -0.08;
        const r54 = makeBrassTopCartridge(track, mats, 0.0056, 0.062);
        r54.position.set(0, 0.054, 0);
        magGroup.add(mb, r54);
      } else {
        const mMat = isKrink ? mats.bakelite : isAk105 ? mats.anodized : mats.gunmetal;
        const s1 = new THREE.Mesh(track(new THREE.BoxGeometry(0.0245, 0.068, 0.052)), mMat);
        s1.position.set(0, 0.036, 0.002);
        s1.rotation.x = -0.06;
        const s2 = new THREE.Mesh(track(new THREE.BoxGeometry(0.0245, 0.068, 0.052)), mMat);
        s2.position.set(0, -0.022, -0.009);
        s2.rotation.x = -0.26;
        const s3 = new THREE.Mesh(track(new THREE.BoxGeometry(0.0242, 0.056, 0.051)), mMat);
        s3.position.set(0, -0.072, -0.029);
        s3.rotation.x = -0.44;
        const topR = makeBrassTopCartridge(track, mats, 0.0048, 0.042);
        topR.position.set(0, 0.072, 0.001);
        magGroup.add(s1, s2, s3, topR);
      }
      magazineHomePos.set(0, -0.082, -0.148);
      magazineHomeQuat.identity();
      magazineEjectAxis.set(0, -0.94, -0.34).normalize();
      magGroup.position.copy(magazineHomePos);
      group.add(magGroup);
      magazine = magGroup;

      // Sights anchored solidly to barrel front sight block & rear sight trunnion block
      const fsZ = muzzleBasePos.z + 0.058;
      const bRad = isSaiga ? 0.0128 : 0.0096;
      const gasBlock = new THREE.Mesh(track(new THREE.BoxGeometry(0.020, 0.026, 0.024)), mats.gunmetal);
      gasBlock.position.set(0, 0.029, hgZ - hgLen * 0.5 - 0.010);
      const fsbCollar = new THREE.Mesh(
        track(new THREE.CylinderGeometry(bRad + 0.003, bRad + 0.0035, 0.024, 12)),
        mats.gunmetal,
      );
      fsbCollar.rotation.x = Math.PI * 0.5;
      fsbCollar.position.set(0, 0.022, fsZ);
      const fsbTower = new THREE.Mesh(track(new THREE.BoxGeometry(0.014, 0.022, 0.018)), mats.gunmetal);
      fsbTower.position.set(0, 0.036, fsZ); // spans [0.025, 0.047] bridging barrel collar to sight hood
      const hoodL = new THREE.Mesh(track(new THREE.BoxGeometry(0.0032, 0.018, 0.014)), mats.gunmetal);
      hoodL.position.set(-0.0072, 0.053, fsZ);
      const hoodR = hoodL.clone();
      hoodR.position.x = 0.0072;
      const fPost = new THREE.Mesh(track(new THREE.BoxGeometry(0.0024, 0.013, 0.0028)), mats.tritiumGreen);
      fPost.position.set(0, 0.0515, fsZ);

      const rsbBase = new THREE.Mesh(track(new THREE.BoxGeometry(0.020, 0.014, 0.032)), mats.gunmetal);
      rsbBase.position.set(0, 0.047, -0.184); // embeds into dustCover top up to 0.054
      const rNotchL = new THREE.Mesh(track(new THREE.BoxGeometry(0.0055, 0.008, 0.008)), mats.gunmetal);
      rNotchL.position.set(-0.0068, 0.057, -0.184);
      const rNotchR = rNotchL.clone();
      rNotchR.position.x = 0.0068;
      const rDotL = new THREE.Mesh(track(new THREE.SphereGeometry(0.0013, 6, 6)), mats.tritiumGreen);
      rDotL.position.set(-0.0068, 0.058, -0.179);
      const rDotR = rDotL.clone();
      rDotR.position.x = 0.0068;
      group.add(gasBlock, fsbCollar, fsbTower, hoodL, hoodR, fPost, rsbBase, rNotchL, rNotchR, rDotL, rDotR);

      ironSightAnchorPos.set(0, 0.058, -0.182);
      sightAnchor.position.copy(ironSightAnchorPos);
      ejectionPortSocket.position.set(0.024, 0.028, -0.112);
      opticMountSocket.position.set(0, 0.044, -0.078);
      cantOpticMountSocket.position.set(0.015, 0.042, -0.235);
      cantSightAnchor.position.copy(cantOpticMountSocket.position);
      muzzleMountSocket.position.copy(muzzleBasePos);
      tacticalMountSocket.position.set(0.021, 0.012, hgZ - 0.03);
      foregripMountSocket.position.set(0, -0.014, hgZ);
      flashlightSocket.position.set(-0.028, 0.016, hgZ - 0.09);
      laserSocket.position.set(0.032, 0.021, hgZ - 0.07);
      magWellSocket.position.copy(magazineHomePos);
      boltRackSocket.position.set(0.036, 0.028, -0.132);

    // =========================================================================
    // PLATFORM 6: HK MP5 ROLLER SMG ('MP5RollerSMG')
    // =========================================================================
    } else if (style === 'MP5RollerSMG') {
      adsEyeReliefM = 0.22;
      muzzleBasePos.set(0, 0.024, -0.415);
      suppressorExtraLenM = 0.152;

      const receiver = new THREE.Mesh(track(new THREE.BoxGeometry(0.034, 0.048, 0.218)), fin.receiver);
      receiver.position.set(0, 0.012, -0.105);
      const upperSpine = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0145, 0.0145, 0.218, 12)), fin.receiver);
      upperSpine.rotation.x = Math.PI * 0.5;
      upperSpine.position.set(0, 0.034, -0.105); // top = 0.0485, bridges receiver cleanly to cockTube & claw mount
      const cockTube = new THREE.Mesh(track(new THREE.CylinderGeometry(0.012, 0.012, 0.185, 12)), fin.receiver);
      cockTube.rotation.x = Math.PI * 0.5;
      cockTube.position.set(0, 0.040, -0.275);
      const handguard = new THREE.Mesh(track(new THREE.BoxGeometry(0.038, 0.034, 0.155)), mats.wornPolymer);
      handguard.position.set(0, 0.008, -0.270);
      const barrel = new THREE.Mesh(track(new THREE.CylinderGeometry(0.009, 0.009, 0.125, 10)), fin.barrel);
      barrel.rotation.x = Math.PI * 0.5;
      barrel.position.set(0, 0.024, -0.352);
      // A3 Collapsible Wireframe Stock
      const sCap = new THREE.Mesh(track(new THREE.BoxGeometry(0.036, 0.052, 0.022)), fin.receiver);
      sCap.position.set(0, 0.012, 0.012);
      const sArmL = new THREE.Mesh(track(new THREE.BoxGeometry(0.006, 0.010, 0.195)), mats.gunmetal);
      sArmL.position.set(-0.017, 0.006, 0.112);
      const sArmR = sArmL.clone();
      sArmR.position.x = 0.017;
      const sPad = new THREE.Mesh(track(new THREE.BoxGeometry(0.034, 0.082, 0.016)), mats.wornPolymer);
      sPad.position.set(0, -0.010, 0.212);
      group.add(receiver, upperSpine, cockTube, handguard, barrel, sCap, sArmL, sArmR, sPad);

      const grip = new THREE.Mesh(track(new THREE.BoxGeometry(0.026, 0.092, 0.036)), mats.wornPolymer);
      grip.position.set(0, -0.054, -0.028);
      grip.rotation.x = 0.26;
      group.add(grip);
      addTrigger(-0.016, -0.068, 0.014, mats.wornPolymer);

      const boltGroup = new THREE.Group();
      boltGroup.name = 'boltCarrierGroup';
      slideBaseZ = 0;
      slideTravelZ = 0.048;
      const carrier = new THREE.Mesh(track(new THREE.BoxGeometry(0.008, 0.014, 0.052)), fin.bolt);
      carrier.position.set(0.016, 0.024, -0.105);
      const chKnob = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0045, 0.0045, 0.024, 8)), mats.wornPolymer);
      chKnob.rotation.z = Math.PI * 0.5;
      chKnob.position.set(-0.022, 0.044, -0.345);
      boltGroup.add(carrier, chKnob);
      group.add(boltGroup);
      slideOrBolt = boltGroup;

      // Curved 30rd 9mm magazine
      const magGroup = new THREE.Group();
      const ms1 = new THREE.Mesh(track(new THREE.BoxGeometry(0.020, 0.074, 0.034)), mats.gunmetal);
      ms1.position.set(0, 0.028, 0);
      const ms2 = new THREE.Mesh(track(new THREE.BoxGeometry(0.020, 0.088, 0.034)), mats.gunmetal);
      ms2.position.set(0, -0.044, -0.010);
      ms2.rotation.x = -0.22;
      const r9 = makeBrassTopCartridge(track, mats, 0.0044, 0.026);
      r9.position.set(0, 0.066, 0);
      magGroup.add(ms1, ms2, r9);
      magazineHomePos.set(0, -0.072, -0.132);
      magazineHomeQuat.identity();
      magazineEjectAxis.set(0, -0.96, -0.25).normalize();
      magGroup.position.copy(magazineHomePos);
      group.add(magGroup);
      magazine = magGroup;

      // MP5 Diopter Drum on Pedestal + Front Sight Tower & Hooded Post (zero floating gaps)
      const diopterGroup = new THREE.Group();
      const diopterBase = new THREE.Mesh(track(new THREE.BoxGeometry(0.018, 0.009, 0.022)), mats.gunmetal);
      diopterBase.position.set(0, 0.048, -0.028);
      const diopter = new THREE.Mesh(track(new THREE.CylinderGeometry(0.009, 0.009, 0.014, 12)), mats.gunmetal);
      diopter.position.set(0, 0.054, -0.028);
      diopterGroup.add(diopterBase, diopter);
      const fTower = new THREE.Mesh(track(new THREE.BoxGeometry(0.015, 0.028, 0.018)), mats.gunmetal);
      fTower.position.set(0, 0.036, -0.365); // bridges barrel (0.024) + cockTube (0.040) to fHood (0.055)
      const fHood = new THREE.Mesh(track(new THREE.TorusGeometry(0.0085, 0.002, 8, 14)), mats.gunmetal);
      fHood.position.set(0, 0.055, -0.365);
      const fPost = new THREE.Mesh(track(new THREE.BoxGeometry(0.0022, 0.011, 0.0028)), mats.tritiumGreen);
      fPost.position.set(0, 0.055, -0.365);
      group.add(diopterGroup, fTower, fHood, fPost);
      ironSightRearUp = diopterGroup;

      ironSightAnchorPos.set(0, 0.055, -0.028);
      sightAnchor.position.copy(ironSightAnchorPos);
      ejectionPortSocket.position.set(0.020, 0.024, -0.105);
      opticMountSocket.position.set(0, 0.046, -0.095);
      muzzleMountSocket.position.copy(muzzleBasePos);
      tacticalMountSocket.position.set(0.019, 0.012, -0.310);
      foregripMountSocket.position.set(0, -0.009, -0.270);
      flashlightSocket.position.set(-0.026, 0.012, -0.365);
      laserSocket.position.set(0.026, 0.014, -0.355);
      magWellSocket.position.copy(magazineHomePos);
      boltRackSocket.position.set(-0.024, 0.044, -0.345);

    // =========================================================================
    // PLATFORM 7: FN P90 BULLPUP PDW ('P90Bullpup')
    // =========================================================================
    } else if (style === 'P90Bullpup') {
      adsEyeReliefM = 0.21;
      muzzleBasePos.set(0, 0.026, -0.268);
      suppressorExtraLenM = 0.155;

      // Olive/Black Bullpup Thumbhole Frame
      const stockRear = new THREE.Mesh(track(new THREE.BoxGeometry(0.044, 0.118, 0.195)), fin.furniture);
      stockRear.position.set(0, -0.014, 0.068);
      const topSpine = new THREE.Mesh(track(new THREE.BoxGeometry(0.040, 0.036, 0.265)), fin.furniture);
      topSpine.position.set(0, 0.030, -0.098);
      const gripBridge = new THREE.Mesh(track(new THREE.BoxGeometry(0.034, 0.088, 0.036)), fin.furniture);
      gripBridge.position.set(0, -0.042, -0.035);
      gripBridge.rotation.x = 0.24;
      const foreGrip = new THREE.Mesh(track(new THREE.BoxGeometry(0.036, 0.082, 0.046)), fin.furniture);
      foreGrip.position.set(0, -0.038, -0.155);
      foreGrip.rotation.x = 0.18;
      const receiverBridge = new THREE.Mesh(track(new THREE.BoxGeometry(0.036, 0.046, 0.095)), fin.receiver);
      receiverBridge.position.set(0, 0.064, -0.182);
      const barrel = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0095, 0.0105, 0.056, 12)), fin.barrel);
      barrel.rotation.x = Math.PI * 0.5;
      barrel.position.set(0, 0.026, -0.242);
      group.add(stockRear, topSpine, gripBridge, foreGrip, receiverBridge, barrel);

      addTrigger(-0.012, -0.112, 0.016, fin.furniture);

      const boltGroup = new THREE.Group();
      slideBaseZ = 0;
      slideTravelZ = 0.044;
      const chargeHandle = new THREE.Mesh(track(new THREE.BoxGeometry(0.052, 0.012, 0.018)), mats.gunmetal);
      chargeHandle.position.set(0, 0.032, -0.165);
      boltGroup.add(chargeHandle);
      group.add(boltGroup);
      slideOrBolt = boltGroup;

      // Top-mounted Translucent Smoke 50-rd P90 Magazine with visible brass 5.7x28 rounds!
      const magGroup = new THREE.Group();
      const magShell = new THREE.Mesh(track(new THREE.BoxGeometry(0.038, 0.022, 0.235)), mats.translucentSmoke);
      magGroup.add(magShell);
      for (let i = 0; i < 12; i++) {
        const round57 = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0038, 0.0038, 0.030, 8)), mats.brass);
        round57.rotation.z = Math.PI * 0.5;
        round57.position.set(0, 0, -0.095 + i * 0.0175);
        magGroup.add(round57);
      }
      magazineHomePos.set(0, 0.058, -0.052);
      magazineHomeQuat.identity();
      magazineEjectAxis.set(0, 1, 0);
      magGroup.position.copy(magazineHomePos);
      group.add(magGroup);
      magazine = magGroup;

      // Backup irons seated flush on receiverBridge top (0.087)
      const rIron = new THREE.Mesh(track(new THREE.BoxGeometry(0.022, 0.012, 0.024)), mats.anodized);
      rIron.position.set(0, 0.092, -0.148);
      const fGuard = new THREE.Mesh(track(new THREE.BoxGeometry(0.014, 0.008, 0.014)), mats.anodized);
      fGuard.position.set(0, 0.0895, -0.218);
      const fPost = new THREE.Mesh(track(new THREE.BoxGeometry(0.0024, 0.008, 0.004)), mats.tritiumGreen);
      fPost.position.set(0, 0.0925, -0.218);
      group.add(rIron, fGuard, fPost);
      ironSightRearUp = rIron;

      ironSightAnchorPos.set(0, 0.094, -0.148);
      sightAnchor.position.copy(ironSightAnchorPos);
      ejectionPortSocket.position.set(0, -0.048, 0.040); // Bottom-eject P90!
      opticMountSocket.position.set(0, 0.087, -0.175);
      muzzleMountSocket.position.copy(muzzleBasePos);
      tacticalMountSocket.position.set(0.018, 0.062, -0.190);
      flashlightSocket.position.set(-0.026, 0.062, -0.228);
      laserSocket.position.set(0.026, 0.062, -0.228);
      magWellSocket.position.copy(magazineHomePos);
      boltRackSocket.position.set(-0.026, 0.032, -0.165);

    // =========================================================================
    // PLATFORM 8: BOLT-ACTION RIFLES ('ClassicWoodBolt' | 'PrecisionChassisBolt')
    // =========================================================================
    } else if (style === 'ClassicWoodBolt' || style === 'PrecisionChassisBolt') {
      const isPrecision = style === 'PrecisionChassisBolt';
      const isMosin = spec.id === 'mosin_m91_30';
      const isMrad = spec.id === 'barrett_mrad';
      const isSv98 = spec.id === 'sv_98';
      const chassisLen = isPrecision ? 0.345 : 0.310;
      const barrelExpose = Math.max(0.18, bLen * 0.62 - 0.25);
      adsEyeReliefM = 0.23;
      muzzleBasePos.set(0, 0.026, -(0.22 + barrelExpose));
      suppressorExtraLenM = 0.21;

      // Cylindrical Action Receiver
      const receiverCyl = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0175, 0.0175, 0.205, 14)), fin.receiver);
      receiverCyl.rotation.x = Math.PI * 0.5;
      receiverCyl.position.set(0, 0.024, -0.095);
      group.add(receiverCyl);

      if (railType === 'dovetail_ak') {
        const sideMount = new THREE.Mesh(track(new THREE.BoxGeometry(0.007, 0.018, 0.095)), mats.anodized);
        sideMount.position.set(-0.020, 0.020, -0.088);
        group.add(sideMount);
      } else {
        const rail = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.021, 0.007, isPrecision ? 0.365 : 0.175)),
          mats.gunmetal,
        );
        rail.position.set(0, 0.0435, isPrecision ? -0.185 : -0.095); // bottom 0.0400 embeds into receiverCyl top 0.0415, top = 0.0470
        group.add(rail);
      }

      // Stock / Precision Chassis
      if (isPrecision) {
        const chassisBody = new THREE.Mesh(
          track(new THREE.BoxGeometry(0.042, 0.046, chassisLen)),
          fin.furniture,
        );
        chassisBody.position.set(0, 0.004, -0.155);
        const grip = new THREE.Mesh(track(new THREE.BoxGeometry(0.028, 0.094, 0.038)), mats.checkeredGrip);
        grip.position.set(0, -0.052, -0.018);
        grip.rotation.x = 0.26;
        const stockBeam = new THREE.Mesh(track(new THREE.BoxGeometry(0.036, 0.068, 0.245)), fin.furniture);
        stockBeam.position.set(0, -0.002, 0.128);
        const cheekRiser = new THREE.Mesh(track(new THREE.BoxGeometry(0.034, 0.022, 0.115)), mats.checkeredGrip);
        cheekRiser.position.set(0, 0.036, 0.135);
        const buttPad = new THREE.Mesh(track(new THREE.BoxGeometry(0.038, 0.098, 0.016)), mats.checkeredGrip);
        buttPad.position.set(0, -0.010, 0.252);
        group.add(chassisBody, grip, stockBeam, cheekRiser, buttPad);

        if (isMrad) {
          const foreShroud = new THREE.Mesh(track(new THREE.BoxGeometry(0.044, 0.048, 0.245)), fin.furniture);
          foreShroud.position.set(0, 0.022, -0.325);
          group.add(foreShroud);
        }
        if (isSv98) {
          const mirageRib = new THREE.Mesh(track(new THREE.BoxGeometry(0.008, 0.006, barrelExpose * 0.72)), mats.anodized);
          mirageRib.position.set(0, 0.040, -0.22 - barrelExpose * 0.38);
          group.add(mirageRib);
        }
      } else {
        const fullStock = new THREE.Mesh(track(new THREE.BoxGeometry(0.038, 0.056, 0.445)), fin.furniture);
        fullStock.position.set(0, -0.002, -0.185);
        const buttStock = new THREE.Mesh(track(new THREE.BoxGeometry(0.034, 0.084, 0.255)), fin.furniture);
        buttStock.position.set(0, -0.018, 0.125);
        buttStock.rotation.x = 0.14;
        const wrist = new THREE.Mesh(track(new THREE.BoxGeometry(0.030, 0.046, 0.075)), fin.furniture);
        wrist.position.set(0, -0.024, 0.006);
        wrist.rotation.x = 0.34;
        const buttPlate = new THREE.Mesh(track(new THREE.BoxGeometry(0.035, 0.092, 0.012)), mats.gunmetal);
        buttPlate.position.set(0, -0.034, 0.254);
        group.add(fullStock, buttStock, wrist, buttPlate);
      }

      addTrigger(-0.016, -0.048, 0.014, mats.gunmetal);

      // Heavy Free-Floated Barrel + Tank Muzzle Brake on Precision Rigs
      const barrel = new THREE.Mesh(
        track(new THREE.CylinderGeometry(isPrecision ? 0.011 : 0.0095, isPrecision ? 0.0135 : 0.012, barrelExpose, 14)),
        fin.barrel,
      );
      barrel.rotation.x = Math.PI * 0.5;
      barrel.position.set(0, 0.026, -0.205 - barrelExpose * 0.5);
      group.add(barrel);

      if (isPrecision) {
        const tankBrake = new THREE.Mesh(track(new THREE.BoxGeometry(0.028, 0.024, 0.054)), mats.anodized);
        tankBrake.position.set(0, 0.026, muzzleBasePos.z + 0.026);
        group.add(tankBrake);
      }

      // Articulated Bolt-Action Carrier + Rotating Bolt Handle Pivot!
      const boltGroup = new THREE.Group();
      slideBaseZ = 0;
      slideTravelZ = 0.088;
      const boltBody = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0105, 0.0105, 0.145, 12)), fin.bolt);
      boltBody.rotation.x = Math.PI * 0.5;
      boltBody.position.set(0, 0.025, -0.075);
      boltGroup.add(boltBody);

      const handlePivot = new THREE.Group();
      handlePivot.position.set(0.010, 0.025, -0.032);
      const stem = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0038, 0.0042, 0.034, 8)), fin.bolt);
      stem.rotation.z = Math.PI * 0.5 + 0.36;
      stem.position.set(0.016, -0.008, 0);
      const knob = new THREE.Mesh(track(new THREE.SphereGeometry(0.0085, 10, 8)), mats.anodized);
      knob.position.set(0.032, -0.016, 0);
      handlePivot.add(stem, knob);
      boltGroup.add(handlePivot);
      group.add(boltGroup);
      slideOrBolt = boltGroup;
      boltHandlePivot = handlePivot;

      // Detachable / Hinged Magazine
      if (!isMosin) {
        const magGroup = new THREE.Group();
        const mb = new THREE.Mesh(track(new THREE.BoxGeometry(0.026, 0.095, 0.086)), mats.gunmetal);
        const fp = new THREE.Mesh(track(new THREE.BoxGeometry(0.029, 0.010, 0.090)), mats.anodized);
        fp.position.set(0, -0.049, 0);
        const rBig = makeBrassTopCartridge(track, mats, 0.0062, 0.068);
        rBig.position.set(0, 0.050, 0);
        magGroup.add(mb, fp, rBig);
        magazineHomePos.set(0, -0.052, -0.125);
        magazineHomeQuat.identity();
        magazineEjectAxis.set(0, -1, 0);
        magGroup.position.copy(magazineHomePos);
        group.add(magGroup);
        magazine = magGroup;
      }

      if (railType === 'dovetail_ak') {
        // Classic Mosin barrel-mounted tangent rear sight + hooded barrel-band front sight
        const fsZ = muzzleBasePos.z + 0.065;
        const rsBase = new THREE.Mesh(track(new THREE.BoxGeometry(0.018, 0.014, 0.038)), mats.gunmetal);
        rsBase.position.set(0, 0.041, -0.185); // embeds into receiverCyl / barrel bridge up to 0.048
        const rNotchL = new THREE.Mesh(track(new THREE.BoxGeometry(0.0048, 0.008, 0.009)), mats.anodized);
        rNotchL.position.set(-0.0055, 0.051, -0.182);
        const rNotchR = rNotchL.clone();
        rNotchR.position.x = 0.0055;
        const barrelBand = new THREE.Mesh(track(new THREE.CylinderGeometry(0.0135, 0.014, 0.022, 12)), mats.gunmetal);
        barrelBand.rotation.x = Math.PI * 0.5;
        barrelBand.position.set(0, 0.026, fsZ);
        const fTower = new THREE.Mesh(track(new THREE.BoxGeometry(0.011, 0.018, 0.016)), mats.gunmetal);
        fTower.position.set(0, 0.041, fsZ);
        const fHood = new THREE.Mesh(track(new THREE.TorusGeometry(0.0068, 0.0018, 8, 12)), mats.gunmetal);
        fHood.position.set(0, 0.052, fsZ);
        const fPost = new THREE.Mesh(track(new THREE.BoxGeometry(0.0022, 0.010, 0.0026)), mats.tritiumGreen);
        fPost.position.set(0, 0.051, fsZ);
        group.add(rsBase, rNotchL, rNotchR, barrelBand, fTower, fHood, fPost);
        ironSightAnchorPos.set(0, 0.052, -0.182);
        sightAnchor.position.copy(ironSightAnchorPos);
      } else {
        addFlipUpIrons(0.0470, 0.064, -0.024, muzzleBasePos.z + 0.065, false, 0.026);
      }

      ejectionPortSocket.position.set(0.022, 0.030, -0.098);
      opticMountSocket.position.set(0, railType === 'dovetail_ak' ? 0.0415 : 0.0470, -0.110);
      cantOpticMountSocket.position.set(0.012, 0.0470, -0.220);
      cantSightAnchor.position.copy(cantOpticMountSocket.position);
      muzzleMountSocket.position.copy(muzzleBasePos);
      tacticalMountSocket.position.set(
        isMrad ? 0.022 : isPrecision ? 0.021 : 0.019,
        isMrad ? 0.022 : isPrecision ? 0.014 : 0.010,
        isMrad ? -0.340 : -0.285,
      );
      foregripMountSocket.position.set(0, isPrecision ? -0.019 : -0.030, -0.285);
      flashlightSocket.position.set(-0.028, 0.022, -0.405);
      laserSocket.position.set(0.028, 0.032, -0.385);
      magWellSocket.position.copy(magazineHomePos);
      boltRackSocket.position.set(0.044, 0.022, -0.032);

    // =========================================================================
    // PLATFORM 9: BATTLE CHASSIS DMR ('BattleChassisDMR' - Mk14 EBR, SCAR-H PR)
    // =========================================================================
    } else if (style === 'BattleChassisDMR') {
      const isScarH = spec.id === 'fn_scar_h_pr';
      const hgLen = 0.265;
      const barrelExpose = Math.max(0.12, bLen * 0.58 - (0.21 + hgLen));
      adsEyeReliefM = 0.23;
      muzzleBasePos.set(0, 0.024, -(0.21 + hgLen + barrelExpose));
      suppressorExtraLenM = 0.185;

      const body = new THREE.Mesh(
        track(new THREE.BoxGeometry(0.040, 0.056, 0.455)),
        fin.receiver,
      );
      body.position.set(0, 0.017, -0.220); // bottom = -0.011, top = 0.045 (meets topRail bottom 0.0445 with zero gap!)
      const topRail = new THREE.Mesh(track(new THREE.BoxGeometry(0.021, 0.007, 0.425)), mats.gunmetal);
      topRail.position.set(0, 0.048, -0.215); // top = 0.0515, z = [-0.4275, -0.0025]
      group.add(body, topRail);

      // Precision Stock
      const sArm1 = new THREE.Mesh(track(new THREE.BoxGeometry(0.012, 0.018, 0.225)), fin.furniture);
      sArm1.position.set(-0.014, 0.014, 0.118);
      const sArm2 = sArm1.clone();
      sArm2.position.x = 0.014;
      const sCheek = new THREE.Mesh(track(new THREE.BoxGeometry(0.036, 0.024, 0.125)), mats.checkeredGrip);
      sCheek.position.set(0, 0.028, 0.135);
      const buttPad = new THREE.Mesh(track(new THREE.BoxGeometry(0.038, 0.098, 0.016)), mats.checkeredGrip);
      buttPad.position.set(0, -0.010, 0.235);
      group.add(sArm1, sArm2, sCheek, buttPad);

      const grip = new THREE.Mesh(track(new THREE.BoxGeometry(0.028, 0.096, 0.038)), mats.checkeredGrip);
      grip.position.set(0, -0.054, -0.022);
      grip.rotation.x = 0.28;
      group.add(grip);
      addTrigger(-0.018, -0.062, 0.014, mats.gunmetal);

      const boltGroup = new THREE.Group();
      boltGroup.name = 'boltCarrierGroup';
      slideBaseZ = 0;
      slideTravelZ = 0.072;
      const opRod = new THREE.Mesh(track(new THREE.BoxGeometry(0.011, 0.015, 0.078)), fin.bolt);
      opRod.position.set(0.020, 0.024, -0.135);
      boltGroup.add(opRod);
      if (isScarH) {
        const scarHandle = new THREE.Mesh(track(new THREE.BoxGeometry(0.022, 0.009, 0.014)), mats.gunmetal);
        scarHandle.position.set(-0.024, 0.032, -0.165);
        boltGroup.add(scarHandle);
        boltRackSocket.position.set(-0.026, 0.032, -0.165);
      } else {
        const ebrHandle = new THREE.Mesh(track(new THREE.BoxGeometry(0.016, 0.010, 0.016)), fin.bolt);
        ebrHandle.position.set(0.027, 0.024, -0.145);
        boltGroup.add(ebrHandle);
        boltRackSocket.position.set(0.030, 0.024, -0.145);
      }
      group.add(boltGroup);
      slideOrBolt = boltGroup;

      const barrel = new THREE.Mesh(track(new THREE.CylinderGeometry(0.010, 0.0115, barrelExpose, 12)), fin.barrel);
      barrel.rotation.x = Math.PI * 0.5;
      barrel.position.set(0, 0.024, -(0.21 + hgLen + barrelExpose * 0.5));
      const brake = new THREE.Mesh(track(new THREE.CylinderGeometry(0.012, 0.012, 0.044, 10)), mats.anodized);
      brake.rotation.x = Math.PI * 0.5;
      brake.position.set(0, 0.024, muzzleBasePos.z + 0.022);
      group.add(barrel, brake);

      const magGroup = new THREE.Group();
      const mb = new THREE.Mesh(track(new THREE.BoxGeometry(0.026, 0.128, 0.074)), fin.furniture);
      const fp = new THREE.Mesh(track(new THREE.BoxGeometry(0.029, 0.010, 0.078)), mats.anodized);
      fp.position.set(0, -0.066, 0);
      const r762 = makeBrassTopCartridge(track, mats, 0.0058, 0.056);
      r762.position.set(0, 0.066, 0);
      magGroup.add(mb, fp, r762);
      magazineHomePos.set(0, -0.076, -0.155);
      magazineHomeQuat.identity();
      magazineEjectAxis.set(0, -1, 0);
      magGroup.position.copy(magazineHomePos);
      group.add(magGroup);
      magazine = magGroup;

      addFlipUpIrons(0.0515, 0.072, -0.024, -0.415);

      ejectionPortSocket.position.set(0.025, 0.028, -0.125);
      opticMountSocket.position.set(0, 0.0515, -0.100);
      cantOpticMountSocket.position.set(0.012, 0.0515, -0.225);
      cantSightAnchor.position.copy(cantOpticMountSocket.position);
      muzzleMountSocket.position.copy(muzzleBasePos);
      tacticalMountSocket.position.set(0.020, 0.024, -0.365);
      foregripMountSocket.position.set(0, -0.011, -0.320);
      flashlightSocket.position.set(-0.028, 0.022, -0.425);
      laserSocket.position.set(0.028, 0.032, -0.395);
      magWellSocket.position.copy(magazineHomePos);

    // =========================================================================
    // PLATFORM 10: TACTICAL & HEAVY-BORE SHOTGUNS ('TubeShotgun' | 'shotgun' | 'HeavyBoreShotgun')
    // =========================================================================
    } else if (style === 'TubeShotgun' || style === 'shotgun' || style === 'HeavyBoreShotgun') {
      const isHeavyBore = style === 'HeavyBoreShotgun';
      const isBenelli = spec.id === 'benelli_m4';
      const isSpas = spec.id === 'spas_12';
      const barrelLen = isHeavyBore ? 0.345 : Math.max(0.32, bLen * 0.56);
      adsEyeReliefM = 0.23;
      muzzleBasePos.set(0, 0.028, -(0.205 + barrelLen));
      suppressorExtraLenM = isBenelli ? 0.205 : 0;

      const receiver = new THREE.Mesh(
        track(new THREE.BoxGeometry(isHeavyBore ? 0.042 : 0.038, 0.056, 0.215)),
        fin.receiver,
      );
      receiver.position.set(0, 0.012, -0.102);
      group.add(receiver);

      if (railType === 'picatinny_top') {
        const rail = new THREE.Mesh(track(new THREE.BoxGeometry(0.021, 0.006, 0.145)), mats.gunmetal);
        rail.position.set(0, 0.0425, -0.102); // bottom 0.0395 embeds into receiver top 0.040, top = 0.0455
        group.add(rail);
      }

      // Stock
      if (isSpas) {
        // SPAS-12 Rear Grip + Iconic Folded Over-Receiver Metal Arm, Rear Hinge Posts & Hook
        const grip = new THREE.Mesh(track(new THREE.BoxGeometry(0.030, 0.088, 0.042)), mats.checkeredGrip);
        grip.position.set(0, -0.048, -0.004);
        grip.rotation.x = 0.30;
        const hingeL = new THREE.Mesh(track(new THREE.BoxGeometry(0.007, 0.024, 0.018)), mats.gunmetal);
        hingeL.position.set(-0.020, 0.036, 0.002);
        const hingeR = hingeL.clone();
        hingeR.position.x = 0.020;
        const armL = new THREE.Mesh(track(new THREE.BoxGeometry(0.006, 0.010, 0.200)), mats.gunmetal);
        armL.position.set(-0.020, 0.048, -0.088);
        const armR = armL.clone();
        armR.position.x = 0.020;
        const hook = new THREE.Mesh(track(new THREE.BoxGeometry(0.046, 0.014, 0.022)), mats.gunmetal);
        hook.position.set(0, 0.048, -0.185);
        group.add(grip, hingeL, hingeR, armL, armR, hook);
      } else if (isBenelli) {
        const grip = new THREE.Mesh(track(new THREE.BoxGeometry(0.030, 0.088, 0.040)), mats.checkeredGrip);
        grip.position.set(0, -0.048, -0.004);
        grip.rotation.x = 0.28;
        const tube = new THREE.Mesh(track(new THREE.CylinderGeometry(0.015, 0.015, 0.22, 10)), mats.gunmetal);
        tube.rotation.x = Math.PI * 0.5;
        tube.position.set(0, 0.014, 0.112);
        const butt = new THREE.Mesh(track(new THREE.BoxGeometry(0.036, 0.090, 0.082)), mats.wornPolymer);
        butt.position.set(0, -0.006, 0.185);
        group.add(grip, tube, butt);
      } else {
        const stock = new THREE.Mesh(track(new THREE.BoxGeometry(0.034, 0.076, 0.245)), fin.furniture);
        stock.position.set(0, -0.022, 0.122);
        stock.rotation.x = 0.15;
        const gripNeck = new THREE.Mesh(track(new THREE.BoxGeometry(0.030, 0.050, 0.072)), fin.furniture);
        gripNeck.position.set(0, -0.026, -0.008);
        gripNeck.rotation.x = 0.36;
        const buttPad = new THREE.Mesh(track(new THREE.BoxGeometry(0.036, 0.094, 0.016)), mats.checkeredGrip);
        buttPad.position.set(0, -0.038, 0.244);
        group.add(stock, gripNeck, buttPad);
      }

      addTrigger(-0.014, -0.052, 0.015, mats.gunmetal);

      const boltGroup = new THREE.Group();
      boltGroup.name = 'boltCarrierGroup';
      slideBaseZ = 0;
      slideTravelZ = 0.068;
      const boltBody = new THREE.Mesh(track(new THREE.BoxGeometry(0.008, 0.018, 0.070)), fin.bolt);
      boltBody.position.set(0.019, 0.022, -0.115);
      boltGroup.add(boltBody);
      group.add(boltGroup);
      slideOrBolt = boltGroup;

      const bRad = isHeavyBore ? 0.0172 : 0.0122;
      const barrel = new THREE.Mesh(track(new THREE.CylinderGeometry(bRad, bRad + 0.001, barrelLen, 14)), fin.barrel);
      barrel.rotation.x = Math.PI * 0.5;
      barrel.position.set(0, 0.028, -0.205 - barrelLen * 0.5);
      const magTube = new THREE.Mesh(
        track(new THREE.CylinderGeometry(bRad * 0.96, bRad * 0.96, barrelLen * 0.88, 12)),
        fin.barrel,
      );
      magTube.rotation.x = Math.PI * 0.5;
      magTube.position.set(0, -0.002, -0.205 - barrelLen * 0.44);
      const clamp = new THREE.Mesh(track(new THREE.BoxGeometry(0.030, 0.044, 0.022)), mats.anodized);
      clamp.position.set(0, 0.012, muzzleBasePos.z + 0.075);
      group.add(barrel, magTube, clamp);

      if (isSpas) {
        const heatShield = new THREE.Mesh(track(new THREE.BoxGeometry(0.032, 0.022, barrelLen * 0.78)), mats.anodized);
        heatShield.position.set(0, 0.032, -0.205 - barrelLen * 0.40);
        group.add(heatShield);
      }

      // Pump Slide Group (fixed polymer forend on Benelli M4, reciprocating pumpSlideGroup on pump shotguns)
      pumpBaseZ = -0.325;
      const pumpGroup = new THREE.Group();
      pumpGroup.name = 'pumpSlideGroup';
      pumpGroup.position.set(0, -0.004, pumpBaseZ);
      const pRad = isHeavyBore ? 0.026 : 0.022;
      const pMat = isBenelli || isSpas ? mats.wornPolymer : fin.furniture;
      const pBody = new THREE.Mesh(
        track(new THREE.CylinderGeometry(isHeavyBore ? 0.025 : 0.021, pRad, 0.165, 12)),
        pMat,
      );
      pBody.rotation.x = Math.PI * 0.5;
      pumpGroup.add(pBody);
      for (let i = 0; i < 6; i++) {
        const gRing = new THREE.Mesh(track(new THREE.TorusGeometry(isHeavyBore ? 0.0255 : 0.0215, 0.002, 6, 12)), mats.anodized);
        gRing.position.z = -0.06 + i * 0.024;
        pumpGroup.add(gRing);
      }
      // Under-pump tactical Picatinny rail + foregripMountSocket parented directly to pumpSlideGroup
      const pumpRail = new THREE.Mesh(track(new THREE.BoxGeometry(0.020, 0.005, 0.115)), mats.gunmetal);
      pumpRail.position.set(0, -(pRad + 0.001), 0);
      pumpGroup.add(pumpRail);
      pumpGroup.add(foregripMountSocket);
      foregripMountSocket.position.set(0, -(pRad + 0.0025), 0);

      group.add(pumpGroup);
      if (!isBenelli) {
        pumpForend = pumpGroup;
      }

      // Left-receiver 4-Shell Side Saddle Carrier
      for (let i = 0; i < 4; i++) {
        const sz = -0.072 - i * 0.024;
        const hull = new THREE.Mesh(
          track(new THREE.CylinderGeometry(isHeavyBore ? 0.011 : 0.0082, isHeavyBore ? 0.011 : 0.0082, 0.046, 10)),
          mats.redShell,
        );
        hull.position.set(-0.028, 0.008, sz);
        const brassH = new THREE.Mesh(
          track(new THREE.CylinderGeometry(isHeavyBore ? 0.0115 : 0.0086, isHeavyBore ? 0.0115 : 0.0086, 0.013, 10)),
          mats.brass,
        );
        brassH.position.set(-0.028, 0.032, sz);
        group.add(hull, brassH);
      }

      // Rear ghost ring on receiver base + barrel-pedestal orange fiber bead (zero floating gaps)
      const ghostGroup = new THREE.Group();
      const ghostBase = new THREE.Mesh(track(new THREE.BoxGeometry(0.020, 0.008, 0.022)), mats.anodized);
      ghostBase.position.set(0, railType === 'picatinny_top' ? 0.0465 : 0.0425, -0.046);
      const ghostWingL = new THREE.Mesh(track(new THREE.BoxGeometry(0.0032, 0.016, 0.014)), mats.anodized);
      ghostWingL.position.set(-0.0095, 0.051, -0.046);
      const ghostWingR = ghostWingL.clone();
      ghostWingR.position.x = 0.0095;
      const ghostRing = new THREE.Mesh(track(new THREE.TorusGeometry(0.0072, 0.0018, 8, 16)), mats.anodized);
      ghostRing.position.set(0, 0.054, -0.046);
      ghostGroup.add(ghostBase, ghostWingL, ghostWingR, ghostRing);

      const frontBeadZ = muzzleBasePos.z + 0.014;
      const frontPedestal = new THREE.Mesh(track(new THREE.BoxGeometry(0.010, 0.016, 0.016)), mats.anodized);
      frontPedestal.position.set(0, 0.046, frontBeadZ); // embeds >= 2mm into barrel top (0.0402..0.0452) up to 0.054
      const frontBead = new THREE.Mesh(track(new THREE.SphereGeometry(0.0028, 8, 8)), mats.fiberOrange);
      frontBead.position.set(0, 0.0545, frontBeadZ);
      group.add(ghostGroup, frontPedestal, frontBead);
      ironSightRearUp = ghostGroup;

      ironSightAnchorPos.set(0, 0.0545, -0.046);
      sightAnchor.position.copy(ironSightAnchorPos);
      ejectionPortSocket.position.set(0.024, 0.024, -0.115);
      const shotgunOpticY = railType === 'picatinny_top' ? 0.0455 : 0.040;
      opticMountSocket.position.set(0, shotgunOpticY, -0.095);
      cantOpticMountSocket.position.set(0.012, shotgunOpticY, -0.168);
      cantSightAnchor.position.copy(cantOpticMountSocket.position);
      muzzleMountSocket.position.copy(muzzleBasePos);
      tacticalMountSocket.position.set(0.015, 0.012, muzzleBasePos.z + 0.075);
      flashlightSocket.position.set(0.026, 0.012, muzzleBasePos.z + 0.040);
      laserSocket.position.set(0.026, 0.016, muzzleBasePos.z + 0.045);
      magWellSocket.position.set(0, -0.022, -0.120);
      boltRackSocket.position.set(-0.022, -0.004, pumpBaseZ);

    // =========================================================================
    // PLATFORM 11: MELEE & THROWABLES ('knife' | 'crowbar' | 'frag_grenade' | 'metal_bolt')
    // =========================================================================
    } else if (style === 'knife') {
      const handle = new THREE.Mesh(track(new THREE.BoxGeometry(0.022, 0.032, 0.115)), mats.bakelite);
      handle.position.set(0, 0, 0.035);
      const pommel = new THREE.Mesh(track(new THREE.BoxGeometry(0.026, 0.036, 0.022)), mats.gunmetal);
      pommel.position.set(0, 0, 0.098);
      const guard = new THREE.Mesh(track(new THREE.BoxGeometry(0.020, 0.068, 0.012)), mats.gunmetal);
      guard.position.set(0, 0.006, -0.025);
      const blade = new THREE.Mesh(track(new THREE.BoxGeometry(0.005, 0.028, 0.155)), mats.chromeSteel);
      blade.position.set(0, 0.002, -0.108);
      const tip = new THREE.Mesh(track(new THREE.ConeGeometry(0.014, 0.045, 4)), mats.chromeSteel);
      tip.rotation.x = -Math.PI * 0.5;
      tip.scale.set(0.25, 1, 1);
      tip.position.set(0, 0.002, -0.205);
      group.add(handle, pommel, guard, blade, tip);
      sightAnchor.position.set(0, 0.02, -0.05);
    } else if (style === 'crowbar') {
      const shaft = new THREE.Mesh(track(new THREE.CylinderGeometry(0.012, 0.012, 0.42, 6)), mats.crowbarRed);
      shaft.rotation.x = Math.PI * 0.5;
      shaft.position.set(0, 0.02, -0.10);
      const bend = new THREE.Mesh(track(new THREE.BoxGeometry(0.024, 0.085, 0.024)), mats.chromeSteel);
      bend.position.set(0, 0.055, -0.31);
      bend.rotation.x = 0.52;
      const claw = new THREE.Mesh(track(new THREE.BoxGeometry(0.028, 0.014, 0.072)), mats.chromeSteel);
      claw.position.set(0, 0.095, -0.285);
      claw.rotation.x = -0.35;
      const chisel = new THREE.Mesh(track(new THREE.BoxGeometry(0.026, 0.012, 0.055)), mats.chromeSteel);
      chisel.position.set(0, 0.016, 0.12);
      chisel.rotation.x = -0.22;
      group.add(shaft, bend, claw, chisel);
      sightAnchor.position.set(0, 0.03, -0.05);
    } else if (style === 'frag_grenade') {
      const body = new THREE.Mesh(track(new THREE.SphereGeometry(0.036, 14, 12)), mats.oliveFrag);
      body.scale.set(0.94, 1.18, 0.94);
      const seamBand = new THREE.Mesh(track(new THREE.CylinderGeometry(0.035, 0.035, 0.010, 14)), mats.gunmetal);
      const neck = new THREE.Mesh(track(new THREE.CylinderGeometry(0.012, 0.015, 0.026, 10)), mats.chromeSteel);
      neck.position.set(0, 0.048, 0);
      const spoon = new THREE.Mesh(track(new THREE.BoxGeometry(0.012, 0.068, 0.010)), mats.chromeSteel);
      spoon.position.set(0, 0.022, 0.034);
      spoon.rotation.x = -0.18;
      const ring = new THREE.Mesh(track(new THREE.TorusGeometry(0.013, 0.0022, 6, 14)), mats.chromeSteel);
      ring.position.set(-0.016, 0.052, -0.004);
      ring.rotation.y = Math.PI * 0.35;
      pinMesh = ring;
      group.add(body, seamBand, neck, spoon, ring);
      sightAnchor.position.set(0, 0.02, 0);
    } else if (style === 'metal_bolt') {
      const shaft = new THREE.Mesh(track(new THREE.CylinderGeometry(0.009, 0.009, 0.065, 8)), mats.chromeSteel);
      shaft.rotation.x = Math.PI * 0.5;
      shaft.position.set(0, 0, -0.015);
      const head = new THREE.Mesh(track(new THREE.CylinderGeometry(0.016, 0.016, 0.015, 6)), mats.chromeSteel);
      head.rotation.x = Math.PI * 0.5;
      head.position.set(0, 0, 0.022);
      const washer = new THREE.Mesh(track(new THREE.CylinderGeometry(0.019, 0.019, 0.004, 12)), mats.gunmetal);
      washer.rotation.x = Math.PI * 0.5;
      washer.position.set(0, 0, 0.012);
      const strip = new THREE.Mesh(track(new THREE.BoxGeometry(0.012, 0.004, 0.055)), mats.clothStrip);
      strip.position.set(0, 0.010, 0.036);
      strip.rotation.x = -0.25;
      group.add(shaft, head, washer, strip);
      sightAnchor.position.set(0, 0.01, 0);
    }

    // Zero muzzle elevation so true barrel ballistics converge dead-on with sightAnchor at 50m
    const heightOverBore = Math.max(0, sightAnchor.position.y - muzzleBasePos.y);
    const zeroElevationRad =
      spec.holdClass === 'pistol' || spec.holdClass === 'rifle' || spec.holdClass === 'shotgun'
        ? Math.atan2(heightOverBore, 50.0)
        : 0;

    const applyMuzzleTransform = (suppressed: boolean): void => {
      muzzleSocket.position.set(
        muzzleBasePos.x,
        muzzleBasePos.y,
        muzzleBasePos.z - (suppressed ? suppressorExtraLenM : 0),
      );
      muzzleSocket.rotation.set(zeroElevationRad, 0, 0);
    };
    applyMuzzleTransform(suppressorAttached && Boolean(suppressor));

    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.layers.set(renderLayer);
        const isGlassOrReticle = obj.material === mats.lensGlass || obj.material === reticleMaterial;
        obj.castShadow = !isGlassOrReticle;
        obj.receiveShadow = !isGlassOrReticle;
      }
    });

    const baseAdsEyeReliefM = adsEyeReliefM;
    const baseMagazine = magazine;

    const asm: WeaponModelAssembly = {
      group,
      weaponId: spec.id,
      visualStyle: spec.visualStyle,
      finish,
      railType,
      isRevolver,
      holdClass: spec.holdClass,
      renderLayer,
      rightHandSocket,
      leftHandSocket,
      hasLeftHandSocket,
      leftGripCurl: baseLeftGripCurl,
      muzzleSocket,
      ejectionPortSocket,
      flashlightSocket,
      laserSocket,
      sightAnchor,
      magWellSocket,
      boltRackSocket,
      opticMountSocket,
      objectiveSocket,
      cantOpticMountSocket,
      cantSightAnchor,
      muzzleMountSocket,
      tacticalMountSocket,
      foregripMountSocket,
      slideOrBolt,
      slideBaseZ,
      slideTravelZ,
      chargingHandle,
      chargingHandleBaseZ,
      boltHandlePivot,
      barrelBreakGroup,
      cylinderPivot,
      revolverChambers,
      hammer,
      hammerBaseRotX,
      trigger,
      triggerBaseRotX,
      baseMagazine,
      magazine,
      magazineHomePos,
      magazineHomeQuat,
      magazineEjectAxis,
      pumpForend,
      pumpBaseZ,
      suppressor,
      flashlightModule,
      laserModule,
      opticGroup,
      reticleMaterial,
      scopeLensMaterial: null,
      hasCantedOptic: false,
      cantReticleMaterial: null,
      cantEyeReliefM: 0.22,
      ocularRadiusM: 0.015,
      hasFlashlightAttachment: false,
      hasLaserAttachment: false,
      foregripPose: 'none',
      pinMesh,
      ironSightRearUp,
      ironSightRearFolded,
      adsEyeReliefM,
      baseAdsEyeReliefM,
      ironSightAnchorPos,
      baseLeftHandPos,
      baseLeftHandRot,
      baseLeftGripCurl,
      muzzleBasePos,
      suppressorExtraLenM,
      zeroElevationRad,
      setSuppressorVisible(visible: boolean): void {
        if (asm.suppressor) {
          asm.suppressor.visible = visible;
        }
        applyMuzzleTransform(visible && Boolean(asm.suppressor));
      },
      dispose(): void {
        asm.disposeAttachments?.();
        for (const g of geos) g.dispose();
        for (const m of customMats) m.dispose();
      },
    };
    return asm;
  }
}

import * as THREE from 'three';
import {
  AttachmentSlot,
  computeDerivedWeaponStats,
  DerivedWeaponStats,
  WeaponAttachments,
} from '../data/attachments';
import {
  BodycamPhysicsWorld,
  BodycamWeaponProfile,
  getWeaponPBRMaterialLibrary,
  WeaponAssembler,
  WeaponModelAssembly,
  WeaponModelFactory,
} from '../bodycam-sdk';

export interface GunsmithPinProjection {
  slot: AttachmentSlot;
  pinLabel: string;
  x: number;
  y: number;
  visible: boolean;
}

export interface GunsmithBenchBuildOptions {
  scene: THREE.Scene;
  physics: BodycamPhysicsWorld;
  raycastMeshes: THREE.Object3D[];
  position: [number, number, number];
  yaw: number;
  isSoftwareGl: boolean;
  woodAlbedo?: THREE.Texture;
  woodRoughness?: THREE.Texture;
}

const PIN_SLOTS: readonly { slot: AttachmentSlot; pinLabel: string }[] = [
  { slot: 'optic', pinLabel: 'OPTIC' },
  { slot: 'canted', pinLabel: 'CANT' },
  { slot: 'muzzle', pinLabel: 'MUZZLE' },
  { slot: 'tactical', pinLabel: 'RAIL' },
  { slot: 'foregrip', pinLabel: 'GRIP' },
  { slot: 'magazine', pinLabel: 'MAG' },
];

export function createEmptyPinProjections(): GunsmithPinProjection[] {
  return PIN_SLOTS.map((p) => ({
    slot: p.slot,
    pinLabel: p.pinLabel,
    x: 0,
    y: 0,
    visible: false,
  }));
}

export class GunsmithBench {
  public readonly root = new THREE.Group();
  public readonly cradleAnchor = new THREE.Group();
  public readonly workLampSpot: THREE.SpotLight;
  public readonly fillLight: THREE.PointLight;

  private readonly scene: THREE.Scene;
  private readonly ownedGeos: THREE.BufferGeometry[] = [];
  private readonly ownedMats: THREE.Material[] = [];

  // Showcase weapon on vise
  private showcaseAssembly: WeaponModelAssembly | null = null;
  private showcaseWeaponId = '';
  private showcaseAttachments: WeaponAttachments = {};
  private showcaseStats: DerivedWeaponStats = computeDerivedWeaponStats(0, 0.25, 0, {});

  // 3D Inspection Camera State Machine
  private active = false;
  private blend = 0; // 0 = FPS camera, 1 = Gunsmith orbit camera
  private orbitYaw = 0.58;
  private orbitPitch = 0.24;
  private orbitYawVel = 0;
  private orbitPitchVel = 0;
  private orbitDist = 0.64;
  private targetDist = 0.64;

  // Pre-allocated scratch buffers (zero GC per frame)
  private readonly _entryPos = new THREE.Vector3();
  private readonly _entryQuat = new THREE.Quaternion();
  private readonly _cradleWorld = new THREE.Vector3();
  private readonly _orbitCamPos = new THREE.Vector3();
  private readonly _orbitCamQuat = new THREE.Quaternion();
  private readonly _lookMat = new THREE.Matrix4();
  private readonly _upVec = new THREE.Vector3(0, 1, 0);
  private readonly _pinWorld = new THREE.Vector3();
  private readonly _pinNdc = new THREE.Vector3();
  private readonly _socketCenterOffset = new THREE.Vector3();

  constructor(opts: GunsmithBenchBuildOptions) {
    this.scene = opts.scene;
    const { physics, raycastMeshes, position, yaw, isSoftwareGl } = opts;

    this.root.position.set(position[0], position[1], position[2]);
    this.root.rotation.y = yaw;
    this.scene.add(this.root);

    const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
      this.ownedGeos.push(g);
      return g;
    };
    const trackMat = <T extends THREE.Material>(m: T): T => {
      this.ownedMats.push(m);
      return m;
    };

    const lib = getWeaponPBRMaterialLibrary();

    const steelFrameMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x2c3136,
        roughness: 0.48,
        metalness: 0.82,
      }),
    );
    const weatheredSteelMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x3b4046,
        roughness: 0.54,
        metalness: 0.72,
      }),
    );
    const oakTopMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: opts.woodAlbedo ?? null,
        roughnessMap: opts.woodRoughness ?? null,
        color: opts.woodAlbedo ? 0xc29e74 : 0x6f4e32,
        roughness: 0.72,
        metalness: 0.04,
      }),
    );
    const rubberMatMaterial = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x16191c,
        roughness: 0.92,
        metalness: 0.05,
      }),
    );
    const brassTrayMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x8f7442,
        roughness: 0.42,
        metalness: 0.78,
      }),
    );
    const lampShadeMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x222a26,
        roughness: 0.36,
        metalness: 0.68,
        side: THREE.DoubleSide,
      }),
    );
    const bulbEmissiveMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xfff3dc,
        emissive: new THREE.Color(0xffdfa8),
        emissiveIntensity: 3.4,
        roughness: 0.15,
      }),
    );

    const registerBenchHitMesh = (mesh: THREE.Mesh, surface: 'wood' | 'metal' = 'metal') => {
      mesh.castShadow = !isSoftwareGl;
      mesh.receiveShadow = !isSoftwareGl;
      mesh.userData.isGunsmithBench = true;
      mesh.userData.surfaceMaterial = surface;
      raycastMeshes.push(mesh);
    };

    // --- 1. Welded Steel Frame & Legs (1.96m wide x 0.90m tall x 0.90m deep) ---
    const benchW = 1.96;
    const benchD = 0.90;
    const topY = 0.90;
    const topThick = 0.065;
    const legH = topY - topThick;

    const legOffsets: [number, number][] = [
      [-benchW * 0.5 + 0.07, -benchD * 0.5 + 0.07],
      [benchW * 0.5 - 0.07, -benchD * 0.5 + 0.07],
      [-benchW * 0.5 + 0.07, benchD * 0.5 - 0.07],
      [benchW * 0.5 - 0.07, benchD * 0.5 - 0.07],
    ];
    for (const [lx, lz] of legOffsets) {
      const leg = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.07, legH, 0.07)), steelFrameMat);
      leg.position.set(lx, legH * 0.5, lz);
      registerBenchHitMesh(leg, 'metal');
      this.root.add(leg);

      const footPad = new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.052, 0.056, 0.018, 10)),
        rubberMatMaterial,
      );
      footPad.position.set(lx, 0.009, lz);
      this.root.add(footPad);
    }

    // Lower storage shelf & cross-braces
    const lowerShelf = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(benchW - 0.14, 0.032, benchD - 0.18)),
      weatheredSteelMat,
    );
    lowerShelf.position.set(0, 0.24, 0);
    registerBenchHitMesh(lowerShelf, 'metal');
    this.root.add(lowerShelf);

    const frontApron = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(benchW - 0.14, 0.07, 0.035)),
      steelFrameMat,
    );
    frontApron.position.set(0, legH - 0.035, benchD * 0.5 - 0.07);
    this.root.add(frontApron);

    // --- 2. Heavy Laminated Oak Benchtop + Armorers Mat ---
    const benchTop = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(benchW, topThick, benchD)),
      oakTopMat,
    );
    benchTop.position.set(0, topY - topThick * 0.5, 0);
    registerBenchHitMesh(benchTop, 'wood');
    this.root.add(benchTop);

    // Front steel edge trim
    const frontEdgeTrim = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(benchW + 0.01, topThick + 0.004, 0.024)),
      steelFrameMat,
    );
    frontEdgeTrim.position.set(0, topY - topThick * 0.5, benchD * 0.5);
    registerBenchHitMesh(frontEdgeTrim, 'metal');
    this.root.add(frontEdgeTrim);

    // Armorers rubber gunsmith mat
    const matSlab = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(1.16, 0.008, 0.56)),
      rubberMatMaterial,
    );
    matSlab.position.set(-0.08, topY + 0.004, 0.06);
    registerBenchHitMesh(matSlab, 'wood');
    this.root.add(matSlab);

    // Thin workbench mat inner surface trim seated cleanly atop rubber mat slab
    const matRule = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(1.12, 0.003, 0.52)),
      trackMat(
        new THREE.MeshStandardMaterial({
          color: 0x262b30,
          roughness: 0.85,
          polygonOffset: true,
          polygonOffsetFactor: -1,
          polygonOffsetUnits: -2,
        }),
      ),
    );
    matRule.position.set(-0.08, topY + 0.0095, 0.06);
    matRule.receiveShadow = !isSoftwareGl;
    this.root.add(matRule);

    // --- 3. Machined Gunsmithing Vise Cradle (centered at -0.08, topY + 0.145, 0.06) ---
    const viseBase = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.18, 0.022, 0.16)),
      steelFrameMat,
    );
    viseBase.position.set(-0.08, topY + 0.015, 0.06);
    registerBenchHitMesh(viseBase, 'metal');
    this.root.add(viseBase);

    const viseTower = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.068, 0.11, 0.068)),
      weatheredSteelMat,
    );
    viseTower.position.set(-0.08, topY + 0.075, 0.06);
    registerBenchHitMesh(viseTower, 'metal');
    this.root.add(viseTower);

    // Padded Y-cradle jaws
    const jawFront = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.082, 0.032, 0.026)),
      rubberMatMaterial,
    );
    jawFront.position.set(-0.08, topY + 0.126, 0.028);
    const jawRear = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.082, 0.032, 0.026)),
      rubberMatMaterial,
    );
    jawRear.position.set(-0.08, topY + 0.126, 0.092);
    const leadScrew = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.008, 0.008, 0.14, 8)),
      lib.chromeSteel,
    );
    leadScrew.rotation.x = Math.PI * 0.5;
    leadScrew.position.set(-0.08, topY + 0.102, 0.06);
    this.root.add(jawFront, jawRear, leadScrew);

    // Showcase weapon rests right on top of the cradle facing sideways (-X) for immediate profile view
    this.cradleAnchor.position.set(-0.08, topY + 0.185, 0.06);
    this.cradleAnchor.rotation.set(0, Math.PI * 0.5, 0);
    this.root.add(this.cradleAnchor);

    // --- 4. Rear Tool & Attachment Tray + Spare Parts Props ---
    const partsTray = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.46, 0.028, 0.34)),
      weatheredSteelMat,
    );
    partsTray.position.set(0.66, topY + 0.014, 0.06);
    registerBenchHitMesh(partsTray, 'metal');
    this.root.add(partsTray);

    // Divided tray rim
    const trayRim = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.44, 0.016, 0.32)),
      rubberMatMaterial,
    );
    trayRim.position.set(0.66, topY + 0.022, 0.06);
    this.root.add(trayRim);

    // Spare 3D parts resting in the bench tray (suppressor tube, bakelite mag, optic, PEQ box, ammo box)
    const spareSupp = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.019, 0.019, 0.165, 14)),
      lib.gunmetal,
    );
    spareSupp.rotation.z = Math.PI * 0.5;
    spareSupp.rotation.y = 0.25;
    spareSupp.position.set(0.62, topY + 0.044, 0.13);

    const spareMag = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.026, 0.052, 0.14)),
      lib.bakelite,
    );
    spareMag.rotation.set(0, 0.42, Math.PI * 0.5);
    spareMag.position.set(0.71, topY + 0.041, -0.02);

    const spareHolo = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.046, 0.044, 0.068)),
      lib.anodized,
    );
    spareHolo.rotation.y = -0.3;
    spareHolo.position.set(0.56, topY + 0.048, -0.03);

    const sparePeq = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.058, 0.026, 0.076)),
      lib.peqFde,
    );
    sparePeq.rotation.y = 0.18;
    sparePeq.position.set(0.75, topY + 0.040, 0.11);

    const ammoCrate = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.24, 0.14, 0.16)),
      lib.oliveFrag,
    );
    ammoCrate.rotation.y = -0.14;
    ammoCrate.position.set(-0.74, topY + 0.07, -0.22);
    registerBenchHitMesh(ammoCrate, 'metal');

    // Brass cartridge cluster on tray
    for (let i = 0; i < 4; i++) {
      const round = new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.0045, 0.0048, 0.038, 8)),
        brassTrayMat,
      );
      round.rotation.z = Math.PI * 0.5;
      round.rotation.y = 0.1 * i - 0.15;
      round.position.set(0.54 + i * 0.015, topY + 0.034, 0.17);
      this.root.add(round);
    }

    this.root.add(spareSupp, spareMag, spareHolo, sparePeq, ammoCrate);

    // Rear low steel tool-rack backsplash
    const backSplash = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(benchW - 0.06, 0.42, 0.03)),
      weatheredSteelMat,
    );
    backSplash.position.set(0, topY + 0.21, -benchD * 0.5 + 0.035);
    registerBenchHitMesh(backSplash, 'metal');
    this.root.add(backSplash);

    // --- 5. Overhead Articulated Work Lamp + Warm Focused SpotLight ---
    const post = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.018, 0.022, 0.66, 10)),
      steelFrameMat,
    );
    post.position.set(-0.56, topY + 0.33, -0.34);
    const armHoriz = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.014, 0.014, 0.64, 10)),
      steelFrameMat,
    );
    armHoriz.rotation.z = -Math.PI * 0.36;
    armHoriz.position.set(-0.31, topY + 0.77, -0.16);
    armHoriz.rotation.y = -0.45;

    const shade = new THREE.Mesh(
      trackGeo(new THREE.ConeGeometry(0.145, 0.14, 16, 1, true)),
      lampShadeMat,
    );
    shade.position.set(-0.08, topY + 0.86, 0.05);
    shade.rotation.x = 0.10;

    const bulb = new THREE.Mesh(
      trackGeo(new THREE.SphereGeometry(0.036, 10, 10)),
      bulbEmissiveMat,
    );
    bulb.position.set(-0.08, topY + 0.82, 0.05);

    this.root.add(post, armHoriz, shade, bulb);

    this.workLampSpot = new THREE.SpotLight(0xffe1b0, 11.5, 4.8, Math.PI * 0.36, 0.55, 1.35);
    this.workLampSpot.position.set(-0.08, topY + 0.80, 0.05);
    if (!isSoftwareGl) {
      this.workLampSpot.castShadow = true;
      this.workLampSpot.shadow.mapSize.set(1024, 1024);
      this.workLampSpot.shadow.camera.near = 0.12;
      this.workLampSpot.shadow.camera.far = 3.5;
      this.workLampSpot.shadow.bias = -0.0004;
    }
    this.workLampSpot.target.position.set(-0.08, topY + 0.14, 0.06);
    this.root.add(this.workLampSpot, this.workLampSpot.target);

    // Cool fill light active only during close-up 3D Gunsmith inspection for clean underside/metal bevel highlights
    this.fillLight = new THREE.PointLight(0xbcd4ec, 0, 2.6, 1.6);
    this.fillLight.position.set(0.28, topY + 0.16, 0.62);
    this.root.add(this.fillLight);

    // --- 6. Register World Physics AABB ---
    // Compute rotated world-space bounding box of bench footprint so collision works cleanly at any yaw
    const cosY = Math.abs(Math.cos(yaw));
    const sinY = Math.abs(Math.sin(yaw));
    const halfExtX = (benchW * 0.5) * cosY + (benchD * 0.5) * sinY;
    const halfExtZ = (benchW * 0.5) * sinY + (benchD * 0.5) * cosY;
    physics.addBox({
      minX: position[0] - halfExtX,
      maxX: position[0] + halfExtX,
      minY: position[1],
      maxY: position[1] + topY + 0.04,
      minZ: position[2] - halfExtZ,
      maxZ: position[2] + halfExtZ,
      surface: 'metal',
    });
  }

  public isOpen(): boolean {
    return this.active;
  }

  public isActiveOrTransitioning(): boolean {
    return this.active || this.blend > 0.004;
  }

  public getDerivedStats(): Readonly<DerivedWeaponStats> {
    return this.showcaseStats;
  }

  private computeIdealOrbitDist(profile: BodycamWeaponProfile): number {
    if (profile.holdClass === 'pistol' || profile.weightClass === 'pistol') {
      return THREE.MathUtils.clamp(0.36 + profile.barrelLengthM * 0.20, 0.42, 0.54);
    }
    if (profile.weightClass === 'heavy_rifle' || profile.barrelLengthM >= 0.92) {
      return THREE.MathUtils.clamp(0.54 + profile.barrelLengthM * 0.44, 0.78, 1.18);
    }
    return THREE.MathUtils.clamp(0.50 + profile.barrelLengthM * 0.30, 0.62, 0.92);
  }

  public enter(
    camera: THREE.Camera,
    profile: BodycamWeaponProfile,
    attachments: WeaponAttachments,
  ): void {
    this._entryPos.copy(camera.position);
    this._entryQuat.copy(camera.quaternion);

    this.active = true;
    this.orbitYaw = 0.52;
    this.orbitPitch = 0.24;
    this.orbitYawVel = 0;
    this.orbitPitchVel = 0;
    this.targetDist = this.computeIdealOrbitDist(profile);
    this.orbitDist = this.targetDist;

    this.setShowcaseWeapon(profile, attachments);
    if (this.showcaseAssembly) {
      this.showcaseAssembly.group.visible = true;
    }
    this.fillLight.intensity = 1.65;
  }

  public exit(camera: THREE.Camera): void {
    this._entryPos.copy(camera.position);
    this._entryQuat.copy(camera.quaternion);
    this.active = false;
    this.fillLight.intensity = 0;
  }

  public setShowcaseWeapon(
    profile: BodycamWeaponProfile,
    attachments?: WeaponAttachments | null,
  ): DerivedWeaponStats {
    const safeProfile =
      profile.holdClass === 'unarmed' ? undefined : profile;
    if (!safeProfile) {
      this.clearShowcaseWeapon();
      return this.showcaseStats;
    }

    if (this.showcaseWeaponId !== safeProfile.id || !this.showcaseAssembly) {
      this.clearShowcaseWeapon();
      this.showcaseWeaponId = safeProfile.id;
      this.targetDist = this.computeIdealOrbitDist(safeProfile);

      const asm = WeaponModelFactory.build(
        {
          id: safeProfile.id,
          holdClass: safeProfile.holdClass,
          barrelLengthM: safeProfile.barrelLengthM,
          visualStyle: safeProfile.visualStyle,
          finish: safeProfile.finish,
          railType: safeProfile.railType,
          isRevolver: safeProfile.isRevolver,
          boreAxisHeightM: safeProfile.boreAxisHeightM,
          modularCaliberId: safeProfile.defaultCaliberId,
          rightHandSocket: safeProfile.rightHandSocket,
          leftHandSocket: safeProfile.leftHandSocket,
          muzzleOffset: safeProfile.muzzleOffset,
          laserOffset: safeProfile.laserOffset,
          supportsSuppressor: safeProfile.supportsSuppressor,
          renderLayer: 0,
        },
        false,
      );

      // Center weapon lengthwise over vise cradle
      const centerZ =
        safeProfile.weightClass === 'pistol'
          ? 0.04
          : safeProfile.weightClass === 'heavy_rifle'
            ? Math.min(0.24, safeProfile.barrelLengthM * 0.20)
            : 0.12;
      asm.group.position.set(0, 0, centerZ);
      this.cradleAnchor.add(asm.group);
      this.showcaseAssembly = asm;
    }

    this.showcaseAttachments = attachments ? { ...attachments } : {};
    this.showcaseStats = WeaponAssembler.applyAttachments(
      this.showcaseAssembly,
      safeProfile.massKg,
      safeProfile.barrelLengthM,
      safeProfile.magCapacity,
      this.showcaseAttachments,
    );
    this.cradleAnchor.updateMatrixWorld(true);
    return this.showcaseStats;
  }

  private clearShowcaseWeapon(): void {
    if (this.showcaseAssembly) {
      this.cradleAnchor.remove(this.showcaseAssembly.group);
      this.showcaseAssembly.dispose();
      this.showcaseAssembly = null;
    }
    this.showcaseWeaponId = '';
  }

  public orbitDrag(deltaX: number, deltaY: number): void {
    this.orbitYawVel -= deltaX * 0.018;
    this.orbitPitchVel += deltaY * 0.016;
  }

  public zoomWheel(deltaY: number): void {
    this.targetDist = THREE.MathUtils.clamp(
      this.targetDist + deltaY * 0.00065,
      0.32,
      1.45,
    );
  }

  /**
   * Steps orbital inertia and interpolates the active camera cleanly between
   * the FPS bodycam view and the 360-degree Gunsmith cradle view.
   * Returns true while camera override is in effect (active or exiting).
   */
  public updateCamera(
    dt: number,
    camera: THREE.Camera,
    fpsCamPos: Readonly<THREE.Vector3>,
    fpsCamQuat: Readonly<THREE.Quaternion>,
  ): boolean {
    const targetBlend = this.active ? 1 : 0;
    this.blend = THREE.MathUtils.damp(this.blend, targetBlend, 11.5, dt);

    if (!this.active && this.blend < 0.005) {
      this.blend = 0;
      if (this.showcaseAssembly) {
        this.showcaseAssembly.group.visible = false;
      }
      return false;
    }

    // Smooth angular inertia & clamped pitch
    this.orbitYaw += this.orbitYawVel * dt * 60 * 0.18;
    this.orbitPitch = THREE.MathUtils.clamp(
      this.orbitPitch + this.orbitPitchVel * dt * 60 * 0.18,
      -0.62,
      1.18,
    );
    const velDamp = Math.exp(-9.5 * dt);
    this.orbitYawVel *= velDamp;
    this.orbitPitchVel *= velDamp;
    this.orbitDist = THREE.MathUtils.damp(this.orbitDist, this.targetDist, 12, dt);

    this.root.updateMatrixWorld(true);
    this.cradleAnchor.getWorldPosition(this._cradleWorld);

    // Subtle elevation target bias so receiver sits nicely above bottom telemetry bar
    this._socketCenterOffset.copy(this._cradleWorld);
    this._socketCenterOffset.y -= 0.015;

    const benchYaw = this.root.rotation.y + this.orbitYaw;
    const cosP = Math.cos(this.orbitPitch);
    const sinP = Math.sin(this.orbitPitch);

    this._orbitCamPos.set(
      this._socketCenterOffset.x + Math.sin(benchYaw) * cosP * this.orbitDist,
      this._socketCenterOffset.y + sinP * this.orbitDist,
      this._socketCenterOffset.z + Math.cos(benchYaw) * cosP * this.orbitDist,
    );

    this._lookMat.lookAt(this._orbitCamPos, this._socketCenterOffset, this._upVec);
    this._orbitCamQuat.setFromRotationMatrix(this._lookMat);

    const smoothT = this.blend * this.blend * (3 - 2 * this.blend);
    if (this.active) {
      camera.position.lerpVectors(this._entryPos, this._orbitCamPos, smoothT);
      camera.quaternion.slerpQuaternions(this._entryQuat, this._orbitCamQuat, smoothT);
    } else {
      camera.position.lerpVectors(fpsCamPos, this._orbitCamPos, smoothT);
      camera.quaternion.slerpQuaternions(fpsCamQuat, this._orbitCamQuat, smoothT);
    }
    camera.updateMatrixWorld(true);
    return true;
  }

  /**
   * Zero-GC projection of the 5 weapon socket world coordinates into CSS pixels.
   */
  public projectPins(
    camera: THREE.Camera,
    viewportW: number,
    viewportH: number,
    outPins: GunsmithPinProjection[],
  ): void {
    const asm = this.showcaseAssembly;
    if (!asm || !this.active) {
      for (let i = 0; i < outPins.length; i++) {
        outPins[i].visible = false;
      }
      return;
    }

    asm.group.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);

    for (let i = 0; i < outPins.length; i++) {
      const pin = outPins[i];
      let socket: THREE.Object3D;
      switch (pin.slot) {
        case 'optic':
          socket = asm.opticMountSocket;
          break;
        case 'canted':
          socket = asm.cantOpticMountSocket;
          break;
        case 'muzzle':
          socket = asm.muzzleMountSocket;
          break;
        case 'tactical':
          socket = asm.tacticalMountSocket;
          break;
        case 'foregrip':
          socket = asm.foregripMountSocket;
          break;
        case 'magazine':
          socket = asm.magWellSocket;
          break;
      }

      socket.getWorldPosition(this._pinWorld);
      this._pinNdc.copy(this._pinWorld).project(camera);

      const inFront = this._pinNdc.z >= -1 && this._pinNdc.z <= 1;
      const sx = (this._pinNdc.x * 0.5 + 0.5) * viewportW;
      const sy = (-this._pinNdc.y * 0.5 + 0.5) * viewportH;

      pin.x = sx;
      pin.y = sy;
      pin.visible =
        inFront && sx >= 24 && sx <= viewportW - 24 && sy >= 24 && sy <= viewportH - 24;
    }
  }

  public dispose(): void {
    this.clearShowcaseWeapon();
    this.scene.remove(this.root);
    for (const g of this.ownedGeos) g.dispose();
    for (const m of this.ownedMats) m.dispose();
  }
}

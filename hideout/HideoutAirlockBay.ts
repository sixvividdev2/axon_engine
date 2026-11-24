import * as THREE from 'three';
import { BodycamPhysicsWorld } from '../bodycam-sdk';
import { HideoutMaterialLibrary } from './HideoutMaterials';
import type { HideoutInteractableMeta } from './HideoutBunkerWorld';

export interface HideoutAirlockBayParams {
  root: THREE.Group;
  physics: BodycamPhysicsWorld;
  materials: HideoutMaterialLibrary;
  raycastMeshes: THREE.Object3D[];
  interactableMeshes: THREE.Mesh[];
  isSoftwareGl: boolean;
}

interface MistPuff {
  mesh: THREE.Mesh;
  originX: number;
  originY: number;
  originZ: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  maxAge: number;
}

function makeBiohazardPanelTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = '#15181b';
  ctx.fillRect(0, 0, 512, 256);

  // Yellow/black diagonal hazard header bar
  ctx.fillStyle = '#d97706';
  ctx.fillRect(0, 0, 512, 34);
  ctx.fillStyle = '#141517';
  for (let x = -32; x < 544; x += 36) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 16, 0);
    ctx.lineTo(x - 4, 34);
    ctx.lineTo(x - 20, 34);
    ctx.closePath();
    ctx.fill();
  }

  ctx.strokeStyle = '#3f464e';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 506, 250);

  // Biohazard warning stencil diamond
  ctx.save();
  ctx.translate(78, 138);
  ctx.rotate(Math.PI * 0.25);
  ctx.fillStyle = '#d97706';
  ctx.fillRect(-34, -34, 68, 68);
  ctx.strokeStyle = '#111315';
  ctx.lineWidth = 4;
  ctx.strokeRect(-27, -27, 54, 54);
  ctx.restore();

  // Simplified grounded biohazard trefoil emblem inside diamond
  ctx.strokeStyle = '#111315';
  ctx.lineWidth = 4;
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI * 0.5 + (i * Math.PI * 2) / 3;
    ctx.beginPath();
    ctx.arc(78 + Math.cos(a) * 11, 138 + Math.sin(a) * 11, 11, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#d97706';
  ctx.beginPath();
  ctx.arc(78, 138, 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#f3f4f6';
  ctx.font = '700 32px "Oswald", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('QUARANTINE AIRLOCK 04', 140, 108);

  ctx.fillStyle = '#f59e0b';
  ctx.font = '600 18px "IBM Plex Mono", monospace';
  ctx.fillText('PRESSURE: 101.3 kPa · SEAL READY', 140, 146);

  ctx.fillStyle = '#9ca3af';
  ctx.font = '500 15px "IBM Plex Mono", monospace';
  ctx.fillText('OVERRIDE [E / F] OR STEP INTO CHAMBER', 140, 184);
  ctx.fillText('DEST: FORTIFIED QUARANTINE OUTPOST', 140, 212);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeBlastDoorTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = '#262b30';
  ctx.fillRect(0, 0, 512, 512);

  // Heavy welded steel plate seams & rivets
  ctx.strokeStyle = '#15181c';
  ctx.lineWidth = 5;
  ctx.strokeRect(10, 10, 492, 492);
  ctx.beginPath();
  ctx.moveTo(10, 175);
  ctx.lineTo(502, 175);
  ctx.moveTo(10, 355);
  ctx.lineTo(502, 355);
  ctx.stroke();

  ctx.fillStyle = '#434b52';
  for (let x = 28; x <= 484; x += 38) {
    for (const y of [24, 162, 188, 342, 368, 488]) {
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Lower yellow/black biohazard hazard stripe band
  ctx.fillStyle = '#d97706';
  ctx.fillRect(14, 372, 484, 72);
  ctx.fillStyle = '#141618';
  for (let x = -48; x < 540; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x, 372);
    ctx.lineTo(x + 22, 372);
    ctx.lineTo(x - 10, 444);
    ctx.lineTo(x - 32, 444);
    ctx.closePath();
    ctx.fill();
  }

  // Stencil lettering
  ctx.fillStyle = '#d1d5db';
  ctx.font = '700 36px "Oswald", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('BIO-CONTAINMENT', 256, 112);
  ctx.fillStyle = '#f59e0b';
  ctx.font = '600 22px "IBM Plex Mono", monospace';
  ctx.fillText('DECON AIRLOCK · SEALED BAY', 256, 148);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Grounded Bio-Containment Airlock Bay (Sector 4 inside Hideout: X ∈ [-4.5, 4.5], Z ∈ [5.5, 13.5])
 * plus exterior armored transport showcase bay (Z ∈ [13.8, 23.0]) visible through a reinforced blast viewport.
 */
export class HideoutAirlockBay {
  public readonly group = new THREE.Group();
  private readonly ownedGeos: THREE.BufferGeometry[] = [];
  private readonly ownedMats: THREE.Material[] = [];
  private readonly ownedTextures: THREE.Texture[] = [];

  private readonly innerDoorLeft: THREE.Group;
  private readonly innerDoorRight: THREE.Group;
  private readonly strobeMeshes: THREE.Mesh[] = [];
  private readonly strobeRotors: THREE.Group[] = [];
  private readonly strobeLight: THREE.PointLight;
  private readonly transportBeaconLight: THREE.PointLight;
  private readonly transportBeaconMesh: THREE.Mesh;
  private readonly transportGroup: THREE.Group;
  private readonly switchPosWorld = new THREE.Vector3(1.98, 1.32, 9.48);

  private readonly mistPuffs: MistPuff[] = [];
  private readonly mistMat: THREE.MeshBasicMaterial;
  private readonly mistOrigins: Array<[number, number, number]> = [];

  private elapsedSec = 0;
  private doorCloseTarget = 0; // 0 = open (1.02m apart per leaf), 1 = sealed shut
  private doorCloseCurrent = 0;
  private deconActive = false;

  constructor(params: HideoutAirlockBayParams) {
    const { root, physics, materials, raycastMeshes, interactableMeshes, isSoftwareGl } = params;
    this.group.name = 'HideoutBioContainmentAirlock';
    root.add(this.group);

    const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
      this.ownedGeos.push(g);
      return g;
    };
    const trackMat = <T extends THREE.Material>(m: T): T => {
      this.ownedMats.push(m);
      return m;
    };
    const trackTex = <T extends THREE.Texture>(t: T): T => {
      this.ownedTextures.push(t);
      return t;
    };

    const addBox = (
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      mat: THREE.Material,
      collidable = true,
      surface: 'concrete' | 'metal' | 'glass' = 'metal',
    ): THREE.Mesh => {
      const m = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, h, d)), mat);
      m.position.set(x, y, z);
      m.receiveShadow = true;
      m.userData.surfaceMaterial = surface;
      this.group.add(m);
      raycastMeshes.push(m);
      if (collidable) {
        physics.addBox({
          minX: x - w * 0.5,
          maxX: x + w * 0.5,
          minY: y - h * 0.5,
          maxY: y + h * 0.5,
          minZ: z - d * 0.5,
          maxZ: z + d * 0.5,
          surface: surface === 'glass' ? 'metal' : surface,
        });
      }
      return m;
    };

    const H_HUB = 3.8;

    // Materials tailored to the Bio-Containment Airlock Bay
    const blastDoorTex = trackTex(makeBlastDoorTexture());
    const blastDoorMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: blastDoorTex,
        roughness: 0.46,
        metalness: 0.72,
      }),
    );

    const panelTex = trackTex(makeBiohazardPanelTexture());
    const panelMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: panelTex,
        emissive: 0x3a250a,
        emissiveMap: panelTex,
        emissiveIntensity: 0.42,
        roughness: 0.4,
        metalness: 0.35,
      }),
    );

    const hazardDecalMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: materials.hazardStripe.map,
        roughness: 0.68,
        metalness: 0.14,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );

    const stainlessMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x8b959e,
        roughness: 0.28,
        metalness: 0.88,
      }),
    );

    const deconTankMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xb45309,
        roughness: 0.42,
        metalness: 0.45,
      }),
    );

    const blastGlassMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x8ea9b8,
        roughness: 0.14,
        metalness: 0.15,
        transparent: true,
        opacity: 0.24,
        depthWrite: false,
      }),
    );

    const strobeCrimsonMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xff5a4f,
        emissive: 0xdc2626,
        emissiveIntensity: 2.2,
        roughness: 0.22,
      }),
    );

    const strobeAmberMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xffd27a,
        emissive: 0xf59e0b,
        emissiveIntensity: 2.1,
        roughness: 0.22,
      }),
    );

    const apcHullMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x2f352e,
        roughness: 0.72,
        metalness: 0.32,
      }),
    );

    const apcTrimMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x181b1d,
        roughness: 0.6,
        metalness: 0.65,
      }),
    );

    const rubberTireMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x121315,
        roughness: 0.92,
        metalness: 0.05,
      }),
    );

    const tarmacMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x1c2024,
        roughness: 0.74,
        metalness: 0.08,
      }),
    );

    const headlightMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xfff3d1,
        emissive: 0xffe4a3,
        emissiveIntensity: 2.8,
        roughness: 0.15,
      }),
    );

    // ------------------------------------------------------------------------
    // 1. INNER AIRLOCK BULKHEAD & HEAVY SLIDING STEEL BLAST DOORS (Z = 9.75)
    // ------------------------------------------------------------------------
    // Flanking heavy steel/concrete bulkhead walls creating a 2.5m wide × 2.55m high blast portal
    addBox(-2.9, H_HUB * 0.5, 9.75, 3.2, H_HUB, 0.46, materials.concreteWall, true, 'concrete');
    addBox(2.9, H_HUB * 0.5, 9.75, 3.2, H_HUB, 0.46, materials.concreteWall, true, 'concrete');
    addBox(0, 3.18, 9.75, 2.7, 1.24, 0.52, materials.darkSteel, true, 'metal');

    // Heavy bevelled steel blast-door jambs + overhead hydraulic slide rail
    addBox(-1.32, 1.32, 9.75, 0.16, 2.64, 0.58, materials.darkSteel, false, 'metal');
    addBox(1.32, 1.32, 9.75, 0.16, 2.64, 0.58, materials.darkSteel, false, 'metal');
    addBox(0, 2.64, 9.48, 3.4, 0.16, 0.22, materials.brushedSteel, false, 'metal');

    // Hydraulic piston rods flanking top rail
    const pistonGeo = trackGeo(new THREE.CylinderGeometry(0.036, 0.036, 1.25, 10));
    for (const side of [-1, 1]) {
      const piston = new THREE.Mesh(pistonGeo, stainlessMat);
      piston.rotation.z = Math.PI * 0.5;
      piston.position.set(side * 1.45, 2.64, 9.38);
      this.group.add(piston);
    }

    // Bi-parting heavy steel sliding blast door leaves (open by default so player can step in or press switch)
    this.innerDoorLeft = new THREE.Group();
    this.innerDoorRight = new THREE.Group();
    const leafGeo = trackGeo(new THREE.BoxGeometry(1.26, 2.54, 0.16));
    const ribGeo = trackGeo(new THREE.BoxGeometry(0.08, 2.48, 0.2));

    const leftLeafMesh = new THREE.Mesh(leafGeo, blastDoorMat);
    leftLeafMesh.position.set(0, 1.27, 0);
    const leftRib = new THREE.Mesh(ribGeo, materials.darkSteel);
    leftRib.position.set(0.58, 1.27, 0);
    this.innerDoorLeft.add(leftLeafMesh, leftRib);
    this.innerDoorLeft.position.set(-1.74, 0, 9.75);

    const rightLeafMesh = new THREE.Mesh(leafGeo, blastDoorMat);
    rightLeafMesh.position.set(0, 1.27, 0);
    const rightRib = new THREE.Mesh(ribGeo, materials.darkSteel);
    rightRib.position.set(-0.58, 1.27, 0);
    this.innerDoorRight.add(rightLeafMesh, rightRib);
    this.innerDoorRight.position.set(1.74, 0, 9.75);

    this.group.add(this.innerDoorLeft, this.innerDoorRight);

    // ------------------------------------------------------------------------
    // 2. BIOHAZARD FLOOR HAZARD STRIPING & STEEL GRATE DRAIN (Zero Z-Fighting)
    // ------------------------------------------------------------------------
    const addFloorStripe = (x: number, z: number, w: number, d: number): void => {
      const strip = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(w, d)), hazardDecalMat);
      strip.rotation.x = -Math.PI * 0.5;
      strip.position.set(x, 0.012, z);
      strip.receiveShadow = true;
      this.group.add(strip);
    };
    // Threshold stripe at inner blast door & chamber perimeter border
    addFloorStripe(0, 9.25, 2.8, 0.34);
    addFloorStripe(0, 10.22, 2.8, 0.34);
    addFloorStripe(0, 13.18, 3.6, 0.32);
    addFloorStripe(-1.82, 11.7, 0.28, 2.7);
    addFloorStripe(1.82, 11.7, 0.28, 2.7);

    // Recessed stainless drainage grate in center of decontamination chamber
    const grateFrame = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.2, 0.024, 1.8)), materials.darkSteel);
    grateFrame.position.set(0, 0.012, 11.75);
    this.group.add(grateFrame);
    const slatGeo = trackGeo(new THREE.BoxGeometry(2.04, 0.028, 0.04));
    for (let i = -5; i <= 5; i++) {
      const slat = new THREE.Mesh(slatGeo, stainlessMat);
      slat.position.set(0, 0.014, 11.75 + i * 0.14);
      this.group.add(slat);
    }

    // ------------------------------------------------------------------------
    // 3. OVERHEAD DECONTAMINATION MIST MANIFOLD, NOZZLES & PRESSURIZED TANKS
    // ------------------------------------------------------------------------
    const pipeLongGeo = trackGeo(new THREE.CylinderGeometry(0.055, 0.055, 3.2, 10));
    for (const px of [-1.45, 1.45]) {
      const pipe = new THREE.Mesh(pipeLongGeo, stainlessMat);
      pipe.rotation.x = Math.PI * 0.5;
      pipe.position.set(px, 3.38, 11.7);
      this.group.add(pipe);
    }
    const crossPipeGeo = trackGeo(new THREE.CylinderGeometry(0.05, 0.05, 3.0, 10));
    for (const pz of [10.6, 12.8]) {
      const cross = new THREE.Mesh(crossPipeGeo, stainlessMat);
      cross.rotation.z = Math.PI * 0.5;
      cross.position.set(0, 3.38, pz);
      this.group.add(cross);
    }

    // 6 angled decontamination mist nozzles + mist origins
    const nozzleGeo = trackGeo(new THREE.ConeGeometry(0.055, 0.16, 8));
    for (const nx of [-1.35, 1.35]) {
      for (const nz of [10.7, 11.7, 12.7]) {
        const nozzle = new THREE.Mesh(nozzleGeo, materials.brushedSteel);
        nozzle.position.set(nx, 3.26, nz);
        nozzle.rotation.z = nx < 0 ? 0.35 : -0.35;
        nozzle.rotation.x = Math.PI;
        this.group.add(nozzle);
        this.mistOrigins.push([nx * 0.9, 3.16, nz]);
      }
    }

    // Wall-mounted high-pressure decontamination agent cylinders inside chamber
    const tankGeo = trackGeo(new THREE.CylinderGeometry(0.18, 0.18, 1.42, 12));
    const tankCapGeo = trackGeo(new THREE.SphereGeometry(0.18, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5));
    for (const side of [-1, 1]) {
      for (const tz of [10.85, 11.45]) {
        const tx = side * 4.12;
        const tank = new THREE.Mesh(tankGeo, deconTankMat);
        tank.position.set(tx, 0.78, tz);
        const cap = new THREE.Mesh(tankCapGeo, materials.darkSteel);
        cap.position.set(tx, 1.49, tz);
        this.group.add(tank, cap);
      }
      // Static collider covering twin tank bank
      physics.addBox({
        minX: side < 0 ? -4.45 : 3.82,
        maxX: side < 0 ? -3.82 : 4.45,
        minY: 0,
        maxY: 1.75,
        minZ: 10.55,
        maxZ: 11.75,
        surface: 'metal',
      });
    }

    // Pooled mist plumes (18 lightweight additive/alpha billboards, zero per-frame allocation)
    this.mistMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0xe6e1d3,
        transparent: true,
        opacity: 0.0,
        depthWrite: false,
      }),
    );
    const mistGeo = trackGeo(new THREE.SphereGeometry(0.32, 7, 6));
    for (let i = 0; i < 18; i++) {
      const o = this.mistOrigins[i % this.mistOrigins.length];
      const m = new THREE.Mesh(mistGeo, this.mistMat);
      m.visible = false;
      m.position.set(o[0], o[1], o[2]);
      this.group.add(m);
      this.mistPuffs.push({
        mesh: m,
        originX: o[0],
        originY: o[1],
        originZ: o[2],
        vx: (o[0] < 0 ? 1 : -1) * (0.45 + (i % 3) * 0.22),
        vy: -(1.35 + (i % 4) * 0.28),
        vz: ((i % 3) - 1) * 0.25,
        age: (i / 18) * 1.1,
        maxAge: 0.95 + (i % 3) * 0.2,
      });
    }

    // ------------------------------------------------------------------------
    // 4. EMERGENCY CRIMSON & AMBER STROBE BEACONS (1 Non-Shadow PointLight)
    // ------------------------------------------------------------------------
    const strobeBaseGeo = trackGeo(new THREE.CylinderGeometry(0.11, 0.13, 0.09, 10));
    const strobeDomeGeo = trackGeo(new THREE.CylinderGeometry(0.085, 0.095, 0.16, 10));
    const rotorBarGeo = trackGeo(new THREE.BoxGeometry(0.12, 0.09, 0.03));

    const strobePlacements: Array<{ x: number; y: number; z: number; amber: boolean }> = [
      { x: -1.65, y: 2.86, z: 9.46, amber: false },
      { x: 1.65, y: 2.86, z: 9.46, amber: true },
      { x: -3.2, y: 2.96, z: 12.6, amber: true },
      { x: 3.2, y: 2.96, z: 12.6, amber: false },
    ];
    for (const sp of strobePlacements) {
      const base = new THREE.Mesh(strobeBaseGeo, materials.darkSteel);
      base.position.set(sp.x, sp.y, sp.z);
      const dome = new THREE.Mesh(strobeDomeGeo, sp.amber ? strobeAmberMat : strobeCrimsonMat);
      dome.position.set(sp.x, sp.y - 0.11, sp.z);
      const rotor = new THREE.Group();
      rotor.position.set(sp.x, sp.y - 0.11, sp.z);
      const bar = new THREE.Mesh(rotorBarGeo, materials.brushedSteel);
      rotor.add(bar);
      this.group.add(base, dome, rotor);
      this.strobeMeshes.push(dome);
      this.strobeRotors.push(rotor);
    }

    this.strobeLight = new THREE.PointLight(0xef4444, 2.2, 13.5, 1.5);
    this.strobeLight.castShadow = false;
    this.strobeLight.position.set(0, 3.15, 11.4);
    this.group.add(this.strobeLight);

    // ------------------------------------------------------------------------
    // 5. AIRLOCK OVERRIDE SWITCH CONSOLES (Exterior + Interior, [F])
    // ------------------------------------------------------------------------
    const proxyMat = trackMat(new THREE.MeshBasicMaterial({ visible: false }));
    const buildOverrideConsole = (x: number, z: number, facingNorth: boolean): void => {
      const consoleGroup = new THREE.Group();
      consoleGroup.position.set(x, 0, z);
      consoleGroup.rotation.y = facingNorth ? Math.PI : 0;

      const pedestal = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.46, 1.24, 0.3)), materials.darkSteel);
      pedestal.position.set(0, 0.62, 0);
      const head = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.56, 0.42, 0.34)), materials.darkSteel);
      head.position.set(0, 1.34, 0.02);
      const screen = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(0.48, 0.24)), panelMat);
      screen.position.set(0, 1.38, 0.195);

      // Physical guarded override button & steel lever
      const btnBase = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.14, 0.08, 0.06)), materials.brushedSteel);
      btnBase.position.set(-0.14, 1.18, 0.19);
      const btnCap = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.036, 0.036, 0.04, 10)), strobeAmberMat);
      btnCap.rotation.x = Math.PI * 0.5;
      btnCap.position.set(-0.14, 1.18, 0.22);

      const lever = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.014, 0.014, 0.15, 8)), strobeCrimsonMat);
      lever.position.set(0.15, 1.2, 0.22);
      lever.rotation.x = 0.42;

      consoleGroup.add(pedestal, head, screen, btnBase, btnCap, lever);
      this.group.add(consoleGroup);

      // Static physics collider
      physics.addBox({
        minX: x - 0.3,
        maxX: x + 0.3,
        minY: 0,
        maxY: 1.56,
        minZ: z - 0.22,
        maxZ: z + 0.22,
        surface: 'metal',
      });

      // Invisible generous raycast proxy for [F] interaction
      const proxy = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.85, 1.25, 0.75)), proxyMat);
      proxy.position.set(x, 1.25, z);
      const meta: HideoutInteractableMeta = {
        kind: 'airlock_override',
        maxDistanceM: 3.1,
      };
      proxy.userData.hideoutInteractable = meta;
      this.group.add(proxy);
      interactableMeshes.push(proxy);
    };

    // Exterior vestibule switch (just right of blast door, facing player walking in from Arsenal)
    buildOverrideConsole(1.98, 9.42, true);
    // Secondary interior chamber switch (right bulkhead inside decon chamber)
    buildOverrideConsole(2.55, 11.4, true);

    // Wall-mounted large biohazard status sign above exterior console
    const wallPanel = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.56, 0.78, 0.06)), panelMat);
    wallPanel.position.set(-2.55, 2.05, 9.48);
    wallPanel.rotation.y = Math.PI;
    this.group.add(wallPanel);

    // ------------------------------------------------------------------------
    // 6. REINFORCED SOUTH VIEWPORT BULKHEAD (Z = 13.75) LOOKING AT TRANSPORT
    // ------------------------------------------------------------------------
    // Lower knee wall (Y = 0..1.05), upper lintel (Y = 2.65..3.8), left/right piers
    addBox(0, 0.525, 13.75, 9.6, 1.05, 0.5, materials.concreteWall, true, 'concrete');
    addBox(0, 3.225, 13.75, 9.6, 1.15, 0.5, materials.concreteWall, true, 'concrete');
    addBox(-3.75, 1.85, 13.75, 2.1, 1.6, 0.5, materials.concreteWall, true, 'concrete');
    addBox(3.75, 1.85, 13.75, 2.1, 1.6, 0.5, materials.concreteWall, true, 'concrete');

    // Heavy steel viewport frame + vertical mullions + solid physics glass plane
    addBox(0, 1.07, 13.72, 5.5, 0.1, 0.56, materials.darkSteel, false, 'metal');
    addBox(0, 2.63, 13.72, 5.5, 0.1, 0.56, materials.darkSteel, false, 'metal');
    for (const mx of [-2.68, -0.9, 0.9, 2.68]) {
      addBox(mx, 1.85, 13.72, 0.12, 1.56, 0.54, materials.darkSteel, false, 'metal');
    }
    const viewportGlass = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(5.32, 1.52, 0.06)), blastGlassMat);
    viewportGlass.position.set(0, 1.85, 13.75);
    this.group.add(viewportGlass);
    physics.addBox({
      minX: -2.75,
      maxX: 2.75,
      minY: 1.0,
      maxY: 2.7,
      minZ: 13.5,
      maxZ: 14.0,
      surface: 'metal',
    });

    // ------------------------------------------------------------------------
    // 7. EXTERIOR QUARANTINE TRANSPORT APRON & IDLING ARMORED TRANSPORT (Z = 14..24)
    // ------------------------------------------------------------------------
    // Exterior tarmac apron, side containment walls, ceiling overhang & distant barrier
    addBox(0, -0.1, 19.0, 14.0, 0.2, 10.6, tarmacMat, false, 'concrete');
    addBox(0, 4.3, 19.0, 14.0, 0.25, 10.6, materials.concreteCeiling, false, 'concrete');
    addBox(-6.8, 2.1, 19.0, 0.4, 4.4, 10.6, materials.concreteWall, false, 'concrete');
    addBox(6.8, 2.1, 19.0, 0.4, 4.4, 10.6, materials.concreteWall, false, 'concrete');
    addBox(0, 2.1, 24.1, 14.0, 4.4, 0.5, materials.darkSteel, false, 'metal');

    // Composite 3D Armored Quarantine Transport (MRAP/APC) idling angled slightly for dramatic silhouette
    this.transportGroup = new THREE.Group();
    this.transportGroup.position.set(-0.35, 0, 17.65);
    this.transportGroup.rotation.y = 0.24;
    this.group.add(this.transportGroup);

    // Lower armored chassis & sloped engine hood
    const chassis = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(5.1, 0.68, 2.28)), apcHullMat);
    chassis.position.set(0, 0.88, 0);
    const crewCab = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(3.4, 1.05, 2.16)), apcHullMat);
    crewCab.position.set(-0.65, 1.66, 0);
    const slopedHood = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.55, 0.72, 1.96)), apcHullMat);
    slopedHood.position.set(1.62, 1.44, 0);
    slopedHood.rotation.z = -0.14;
    const frontBumper = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.32, 0.42, 2.34)), apcTrimMat);
    frontBumper.position.set(2.58, 0.78, 0);
    const rearRamp = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.16, 1.42, 1.72)), blastDoorMat);
    rearRamp.position.set(-2.42, 1.28, 0);
    rearRamp.rotation.z = 0.16;

    // Armored windshield slits & side viewports
    const windshield = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.12, 0.36, 1.68)), apcTrimMat);
    windshield.position.set(1.06, 1.82, 0);
    windshield.rotation.z = 0.18;
    const sideVisorL = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.1, 0.28, 0.08)), apcTrimMat);
    sideVisorL.position.set(-0.55, 1.82, -1.08);
    const sideVisorR = sideVisorL.clone();
    sideVisorR.position.z = 1.08;

    // Roof cargo rack & rotating amber lightbar
    const roofRack = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.8, 0.12, 1.84)), apcTrimMat);
    roofRack.position.set(-0.65, 2.24, 0);
    this.transportBeaconMesh = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.24, 0.16, 1.1)), strobeAmberMat);
    this.transportBeaconMesh.position.set(0.65, 2.32, 0);

    // Twin warm halogen headlights
    const headL = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.08, 0.2, 0.28)), headlightMat);
    headL.position.set(2.42, 1.22, -0.72);
    const headR = headL.clone();
    headR.position.z = 0.72;

    this.transportGroup.add(
      chassis,
      crewCab,
      slopedHood,
      frontBumper,
      rearRamp,
      windshield,
      sideVisorL,
      sideVisorR,
      roofRack,
      this.transportBeaconMesh,
      headL,
      headR,
    );

    // 4 rugged heavy-duty MRAP wheels with steel hubs (grounded cleanly at y = 0)
    const wheelGeo = trackGeo(new THREE.CylinderGeometry(0.54, 0.54, 0.42, 14));
    const hubGeo = trackGeo(new THREE.CylinderGeometry(0.25, 0.25, 0.45, 10));
    const wheelCoords: Array<[number, number]> = [
      [1.58, -1.16],
      [1.58, 1.16],
      [-1.52, -1.16],
      [-1.52, 1.16],
    ];
    for (const [wx, wz] of wheelCoords) {
      const tire = new THREE.Mesh(wheelGeo, rubberTireMat);
      tire.rotation.x = Math.PI * 0.5;
      tire.position.set(wx, 0.54, wz);
      const hub = new THREE.Mesh(hubGeo, materials.brushedSteel);
      hub.rotation.x = Math.PI * 0.5;
      hub.position.set(wx, 0.54, wz);
      this.transportGroup.add(tire, hub);
    }

    // Single non-shadow amber exterior bay light illuminating the idling APC through the glass
    this.transportBeaconLight = new THREE.PointLight(0xf59e0b, isSoftwareGl ? 3.2 : 4.2, 16, 1.35);
    this.transportBeaconLight.castShadow = false;
    this.transportBeaconLight.position.set(0.4, 3.25, 16.4);
    this.group.add(this.transportBeaconLight);
  }

  /** Returns true when player walks deep inside the sealed decontamination chamber */
  public isInsideAirlockChamber(x: number, z: number): boolean {
    return Math.abs(x) <= 1.75 && z >= 10.65 && z <= 13.18;
  }

  public getOverrideSwitchWorldPos(outPos: THREE.Vector3): boolean {
    outPos.copy(this.switchPosWorld);
    return true;
  }

  /** Initiates sliding steel blast door seal + overhead decontamination mist burst */
  public triggerPressurizationCycle(): void {
    this.doorCloseTarget = 1;
    this.deconActive = true;
    for (let i = 0; i < this.mistPuffs.length; i++) {
      const p = this.mistPuffs[i];
      p.mesh.visible = true;
      p.age = (i / this.mistPuffs.length) * 0.55;
      p.mesh.position.set(p.originX, p.originY, p.originZ);
      p.mesh.scale.setScalar(0.45);
    }
  }

  public resetCycle(): void {
    this.doorCloseTarget = 0;
    this.deconActive = false;
    this.mistMat.opacity = 0;
    for (let i = 0; i < this.mistPuffs.length; i++) {
      this.mistPuffs[i].mesh.visible = false;
    }
  }

  public update(dt: number): void {
    const clampedDt = Math.min(dt, 0.05);
    this.elapsedSec += clampedDt;

    // Smooth heavy hydraulic blast door slide (open: ±1.74m -> sealed: ±0.635m)
    const speed = this.doorCloseTarget > 0.5 ? 7.8 : 4.5;
    this.doorCloseCurrent = THREE.MathUtils.damp(
      this.doorCloseCurrent,
      this.doorCloseTarget,
      speed,
      clampedDt,
    );
    const leafX = THREE.MathUtils.lerp(1.74, 0.635, this.doorCloseCurrent);
    this.innerDoorLeft.position.x = -leafX;
    this.innerDoorRight.position.x = leafX;

    // Rotating emergency crimson & amber wall strobes
    const pulseRate = this.deconActive ? 11.5 : 3.4;
    const pulse = 0.5 + 0.5 * Math.sin(this.elapsedSec * pulseRate);
    for (let i = 0; i < this.strobeRotors.length; i++) {
      this.strobeRotors[i].rotation.y += clampedDt * (this.deconActive ? 9.0 : 3.2);
    }
    this.strobeLight.intensity = this.deconActive ? 1.8 + pulse * 4.4 : 1.1 + pulse * 1.4;
    this.strobeLight.color.setHex(pulse > 0.55 ? 0xdc2626 : 0xf59e0b);

    // Subtle diesel idle vibration & amber roof beacon pulse on exterior Armored Transport
    const apcPulse = 0.5 + 0.5 * Math.sin(this.elapsedSec * 5.2 + 0.8);
    this.transportGroup.position.y = Math.sin(this.elapsedSec * 28.0) * 0.0035;
    this.transportBeaconLight.intensity = 2.6 + apcPulse * 2.2;
    const beaconMat = this.transportBeaconMesh.material as THREE.MeshStandardMaterial;
    beaconMat.emissiveIntensity = 1.2 + apcPulse * 2.1;

    // Overhead decontamination mist burst when active
    if (this.deconActive) {
      this.mistMat.opacity = THREE.MathUtils.damp(this.mistMat.opacity, 0.52, 6.0, clampedDt);
      for (let i = 0; i < this.mistPuffs.length; i++) {
        const p = this.mistPuffs[i];
        p.age += clampedDt;
        if (p.age >= p.maxAge) {
          p.age = 0;
          p.mesh.position.set(p.originX, p.originY, p.originZ);
        } else {
          p.mesh.position.x += p.vx * clampedDt;
          p.mesh.position.y += p.vy * clampedDt;
          p.mesh.position.z += p.vz * clampedDt;
        }
        const t = p.age / p.maxAge;
        const sc = 0.45 + t * 2.4;
        p.mesh.scale.set(sc, sc * 0.72, sc);
      }
    }
  }

  public dispose(): void {
    this.group.parent?.remove(this.group);
    for (const g of this.ownedGeos) g.dispose();
    for (const m of this.ownedMats) m.dispose();
    for (const t of this.ownedTextures) t.dispose();
  }
}

import * as THREE from 'three';
import { BodycamPhysicsWorld } from '../bodycam-sdk';
import { HideoutElectronicsSystem } from './HideoutElectronicsSystem';
import { HideoutMaterialLibrary } from './HideoutMaterials';
import type { HideoutInteractableMeta } from './HideoutBunkerWorld';

import type { ReadyRoomOpenWorldSummary } from '../src/modes/openworld/HideoutShardAdapter';

export interface ReadyRoomBriefingState {
  mapId: string;
  mapName: string;
  mapSubtitle: string;
  ruleLabel: string;
  botCount: number;
  killLimit: number;
  difficultyLabel: string;
  weatherLabel: string;
  timeOfDayLabel: string;
  primaryWeaponName: string;
  secondaryWeaponName: string;
  grenadeName: string;
  operatorLabel: string;
  rankLabel: string;
  lobbyCode: string | null;
  lobbyMembersCount: number;
  lobbyMaxPlayers: number;
  openWorldCharacter?: ReadyRoomOpenWorldSummary | null;
}

const DEFAULT_BRIEFING: ReadyRoomBriefingState = {
  mapId: 'pripyat_block',
  mapName: 'Pripyat Microdistrict',
  mapSubtitle: 'Urban Courtyard CQB',
  ruleLabel: 'TDM · Team Deathmatch',
  botCount: 6,
  killLimit: 30,
  difficultyLabel: 'Tactical',
  weatherLabel: 'Auto',
  timeOfDayLabel: 'Auto (Random)',
  primaryWeaponName: 'M4A1 Carbine',
  secondaryWeaponName: 'Makarov PM',
  grenadeName: 'M67 Frag',
  operatorLabel: 'Standard Operator',
  rankLabel: 'Rank 1',
  lobbyCode: null,
  lobbyMembersCount: 0,
  lobbyMaxPlayers: 0,
};

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

function drawCrackedGlassOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  header: string,
  subtext: string,
): void {
  ctx.fillStyle = '#07090b';
  ctx.fillRect(0, 0, w, h);

  // Subtle horizontal dead-scanline noise bands
  ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
  for (let y = 0; y < h; y += 6) {
    ctx.fillRect(0, y, w, 2);
  }

  // Impact spiderweb cracks from upper-center-right
  const cx = w * 0.56;
  const cy = h * 0.44;
  ctx.strokeStyle = 'rgba(210, 224, 238, 0.42)';
  ctx.lineWidth = 1.6;
  const rays = 11;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2 + 0.18;
    const len = Math.max(w, h) * (0.35 + ((i * 37) % 10) * 0.04);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    const midX = cx + Math.cos(a + 0.08) * len * 0.45;
    const midY = cy + Math.sin(a - 0.06) * len * 0.45;
    ctx.lineTo(midX, midY);
    ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(180, 198, 214, 0.25)';
  ctx.lineWidth = 1.1;
  for (const r of [24, 56, 102]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Faint crimson failure banner
  ctx.fillStyle = 'rgba(153, 27, 27, 0.22)';
  ctx.fillRect(w * 0.12, h * 0.36, w * 0.76, h * 0.28);
  ctx.strokeStyle = 'rgba(239, 68, 68, 0.42)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(w * 0.12, h * 0.36, w * 0.76, h * 0.28);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#fca5a5';
  ctx.font = `700 ${Math.round(h * 0.09)}px "IBM Plex Mono", monospace`;
  ctx.fillText(header, w * 0.5, h * 0.49);
  ctx.fillStyle = '#9ca3af';
  ctx.font = `600 ${Math.round(h * 0.055)}px "IBM Plex Mono", monospace`;
  ctx.fillText(subtext, w * 0.5, h * 0.58);
  ctx.textAlign = 'left';
}

function buildTopoTableMapTexture(maxAniso: number): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(768, 512);

  // Matte tactical chart paper base
  ctx.fillStyle = '#cfd4c8';
  ctx.fillRect(0, 0, 768, 512);

  // Faint warm paper age vignette
  const grad = ctx.createRadialGradient(384, 256, 80, 384, 256, 460);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(1, 'rgba(42,38,30,0.22)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 768, 512);

  // Contour rings
  ctx.strokeStyle = 'rgba(92, 76, 52, 0.34)';
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 9; i++) {
    ctx.beginPath();
    ctx.ellipse(230 + i * 8, 220 - i * 4, 42 + i * 26, 28 + i * 18, 0.35, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let i = 0; i < 7; i++) {
    ctx.beginPath();
    ctx.ellipse(560 - i * 6, 330 + i * 4, 34 + i * 22, 22 + i * 16, -0.4, 0, Math.PI * 2);
    ctx.stroke();
  }

  // River / canal corridor
  ctx.strokeStyle = 'rgba(54, 102, 126, 0.55)';
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.moveTo(0, 390);
  ctx.bezierCurveTo(210, 340, 410, 440, 768, 280);
  ctx.stroke();

  // MGRS grid lines
  ctx.strokeStyle = 'rgba(30, 44, 52, 0.28)';
  ctx.lineWidth = 1;
  for (let x = 64; x < 768; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 28);
    ctx.lineTo(x, 484);
    ctx.stroke();
  }
  for (let y = 64; y < 512; y += 64) {
    ctx.beginPath();
    ctx.moveTo(28, y);
    ctx.lineTo(740, y);
    ctx.stroke();
  }

  // Red grease-pencil ingress arrow & objective circle
  ctx.strokeStyle = 'rgba(185, 28, 28, 0.85)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(385, 215, 42, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(118, 326);
  ctx.quadraticCurveTo(235, 290, 340, 232);
  ctx.stroke();

  // Blue staging rally box
  ctx.strokeStyle = 'rgba(29, 78, 216, 0.8)';
  ctx.lineWidth = 3;
  ctx.strokeRect(86, 310, 56, 34);

  // Border & coordinate header
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 3;
  ctx.strokeRect(20, 20, 728, 472);
  ctx.fillStyle = '#1e2428';
  ctx.font = '700 18px "IBM Plex Mono", monospace';
  ctx.fillText('SECTOR GRID 44-N // TACTICAL TOPOGRAPHIC CHART', 36, 48);
  ctx.font = '600 13px "IBM Plex Mono", monospace';
  ctx.fillText('SCALE 1:25,000   DATUM WGS-84   OBJ ALPHA', 36, 476);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

function buildKeyboardDeckTexture(maxAniso: number): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(512, 256);
  ctx.fillStyle = '#121519';
  ctx.fillRect(0, 0, 512, 256);

  // Recessed keywell
  ctx.fillStyle = '#090b0e';
  ctx.fillRect(24, 18, 464, 150);

  // Rows of backlit rugged keys
  const rows = 5;
  const cols = 14;
  const keyW = 29;
  const keyH = 24;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const kx = 32 + col * 32;
      const ky = 26 + r * 28;
      if (r === 4 && col >= 4 && col <= 9) continue;
      ctx.fillStyle = '#1d2229';
      ctx.fillRect(kx, ky, keyW, keyH);
      ctx.strokeStyle = 'rgba(96, 165, 250, 0.34)';
      ctx.lineWidth = 1;
      ctx.strokeRect(kx + 0.5, ky + 0.5, keyW - 1, keyH - 1);
    }
  }
  // Spacebar
  ctx.fillStyle = '#1d2229';
  ctx.fillRect(32 + 4 * 32, 26 + 4 * 28, 6 * 32 - 3, keyH);
  ctx.strokeStyle = 'rgba(245, 158, 11, 0.42)';
  ctx.strokeRect(32 + 4 * 32 + 0.5, 26 + 4 * 28 + 0.5, 6 * 32 - 4, keyH - 1);

  // Trackpad & mouse buttons
  ctx.fillStyle = '#181c22';
  ctx.fillRect(190, 182, 132, 58);
  ctx.strokeStyle = '#2d3540';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(190, 182, 132, 58);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

/**
 * Phase 4 Ready Room — Ops Command Laptop, Live Tactical Sector Briefing Wall,
 * Twin Wall Telemetry Monitors, Encrypted Comms Rack, and Briefing Furniture.
 * Every electronic display, radio, and light fixture integrates with HideoutElectronicsSystem.
 */
export class HideoutReadyRoom {
  private readonly ownedGeos: THREE.BufferGeometry[] = [];
  private readonly ownedMats: THREE.Material[] = [];
  private readonly ownedTexs: THREE.Texture[] = [];

  private readonly laptopWorldPos = new THREE.Vector3(-10.82, 0.96, 0.04);
  private readonly boardWorldPos = new THREE.Vector3(-16.18, 1.72, 0.0);

  private readonly laptopCanvas: HTMLCanvasElement;
  private readonly laptopCtx: CanvasRenderingContext2D;
  private readonly laptopTex: THREE.CanvasTexture;
  private readonly laptopScreenMat: THREE.MeshStandardMaterial;

  private readonly boardCanvas: HTMLCanvasElement;
  private readonly boardCtx: CanvasRenderingContext2D;
  private readonly boardTex: THREE.CanvasTexture;

  private readonly loadoutMonCanvas: HTMLCanvasElement;
  private readonly loadoutMonCtx: CanvasRenderingContext2D;
  private readonly loadoutMonTex: THREE.CanvasTexture;
  private readonly loadoutMonMat: THREE.MeshStandardMaterial;

  private readonly commsMonCanvas: HTMLCanvasElement;
  private readonly commsMonCtx: CanvasRenderingContext2D;
  private readonly commsMonTex: THREE.CanvasTexture;
  private readonly commsMonMat: THREE.MeshStandardMaterial;

  private readonly electronics: HideoutElectronicsSystem;
  private briefing: ReadyRoomBriefingState = { ...DEFAULT_BRIEFING };

  private laptopBroken = false;
  private loadoutMonBroken = false;
  private commsMonBroken = false;
  private radioBroken = false;

  private animTime = 0;
  private commsRedrawAccum = 0;

  constructor(
    root: THREE.Group,
    physics: BodycamPhysicsWorld,
    materials: HideoutMaterialLibrary,
    electronics: HideoutElectronicsSystem,
    raycastMeshes: THREE.Object3D[],
    interactableMeshes: THREE.Mesh[],
    isSoftwareGl: boolean,
    maxAniso: number,
  ) {
    this.electronics = electronics;

    const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
      this.ownedGeos.push(g);
      return g;
    };
    const trackMat = <T extends THREE.Material>(m: T): T => {
      this.ownedMats.push(m);
      return m;
    };
    const trackTex = <T extends THREE.Texture>(t: T): T => {
      this.ownedTexs.push(t);
      return t;
    };

    const readyGroup = new THREE.Group();
    readyGroup.name = 'HideoutReadyRoom';
    root.add(readyGroup);

    const proxyMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x00ffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );

    const chassisBlackMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x15181d,
        roughness: 0.42,
        metalness: 0.72,
      }),
    );
    const rubberBumperMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x1c1e21,
        roughness: 0.9,
        metalness: 0.05,
      }),
    );
    const oliveMetalMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x353c34,
        roughness: 0.62,
        metalness: 0.35,
      }),
    );
    const slateTableTopMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x262a2e,
        roughness: 0.72,
        metalness: 0.18,
      }),
    );
    const screenCoolLightMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xe6f2ff,
        emissive: new THREE.Color(0x93c5fd),
        emissiveIntensity: 1.55,
        roughness: 0.25,
      }),
    );
    const statusBeaconMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xfef3c7,
        emissive: new THREE.Color(0x38bdf8),
        emissiveIntensity: 1.75,
        roughness: 0.2,
      }),
    );
    const radioFaceEmissiveMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        emissive: new THREE.Color(0xf59e0b),
        emissiveIntensity: 0.85,
        roughness: 0.35,
      }),
    );

    // =========================================================================
    // 1. ARCHITECTURAL PILASTERS, CEILING BEAMS & WARM/COOL READY ROOM LIGHTING
    // =========================================================================
    const H_HUB = 3.8;
    for (const px of [-16.32, -11.5, -6.72]) {
      for (const pz of [-4.82, 4.82]) {
        const col = new THREE.Mesh(
          trackGeo(new THREE.BoxGeometry(0.32, H_HUB, 0.32)),
          materials.darkSteel,
        );
        col.position.set(px, H_HUB * 0.5, pz);
        readyGroup.add(col);
      }
    }
    for (const bx of [-14.2, -11.5, -8.8]) {
      const beam = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.24, 0.26, 10.0)),
        materials.darkSteel,
      );
      beam.position.set(bx, H_HUB - 0.13, 0);
      readyGroup.add(beam);
    }

    // Subtle cool tactical accent light over West Briefing Wall + Laptop desk bounce
    const boardWashLight = new THREE.PointLight(0xdceaff, 1.35, 9.5, 1.6);
    boardWashLight.position.set(-15.2, 2.75, 0);
    readyGroup.add(boardWashLight);

    const laptopScreenLight = new THREE.PointLight(0x60a5fa, 0.82, 4.2, 1.8);
    laptopScreenLight.position.set(-10.55, 1.18, 0.04);
    readyGroup.add(laptopScreenLight);

    // =========================================================================
    // 2. CENTERPIECE: HEAVY STEEL TACTICAL OPS TABLE (X = -11.4, Z = 0.0)
    // =========================================================================
    const tableX = -11.4;
    const tableZ = 0.0;
    const tableW = 2.38; // along X
    const tableD = 1.34; // along Z
    const tableH = 0.86;

    const opsTableGroup = new THREE.Group();
    opsTableGroup.position.set(tableX, 0, tableZ);
    readyGroup.add(opsTableGroup);

    const tableTop = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(tableW, 0.07, tableD)),
      slateTableTopMat,
    );
    tableTop.position.set(0, tableH - 0.035, 0);
    tableTop.castShadow = !isSoftwareGl;
    tableTop.receiveShadow = true;
    opsTableGroup.add(tableTop);
    raycastMeshes.push(tableTop);

    // Steel perimeter apron + 4 bolted legs + lower stretcher rail
    const apron = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(tableW - 0.08, 0.09, tableD - 0.08)),
      materials.darkSteel,
    );
    apron.position.set(0, tableH - 0.11, 0);
    opsTableGroup.add(apron);

    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new THREE.Mesh(
          trackGeo(new THREE.BoxGeometry(0.085, tableH - 0.08, 0.085)),
          materials.darkSteel,
        );
        leg.position.set(sx * (tableW * 0.5 - 0.14), (tableH - 0.08) * 0.5, sz * (tableD * 0.5 - 0.14));
        leg.castShadow = !isSoftwareGl;
        opsTableGroup.add(leg);

        const foot = new THREE.Mesh(
          trackGeo(new THREE.BoxGeometry(0.14, 0.025, 0.14)),
          materials.brushedSteel,
        );
        foot.position.set(sx * (tableW * 0.5 - 0.14), 0.0125, sz * (tableD * 0.5 - 0.14));
        opsTableGroup.add(foot);
      }
    }
    const lowerRail = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(tableW - 0.34, 0.045, 0.06)),
      materials.darkSteel,
    );
    lowerRail.position.set(0, 0.24, 0);
    opsTableGroup.add(lowerRail);

    // Spread Laminated Topographic Map on the West side of the table
    const topoTex = trackTex(buildTopoTableMapTexture(maxAniso));
    const topoMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: topoTex,
        roughness: 0.58,
        metalness: 0.04,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    );
    const topoMap = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(1.12, 0.78)), topoMat);
    topoMap.rotation.x = -Math.PI * 0.5;
    topoMap.rotation.z = 0.05;
    topoMap.position.set(-0.46, tableH + 0.004, 0.04);
    opsTableGroup.add(topoMap);

    // Brass compass & steel puck weights holding down map corners
    const compassBody = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.036, 0.04, 0.018, 16)),
      materials.brassCasing,
    );
    compassBody.position.set(-0.88, tableH + 0.011, -0.26);
    opsTableGroup.add(compassBody);

    const puckWeight = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.032, 0.034, 0.024, 14)),
      materials.brushedSteel,
    );
    puckWeight.position.set(-0.04, tableH + 0.014, 0.34);
    opsTableGroup.add(puckWeight);

    // Pelican-style hardcase at North-West table corner
    const caseGroup = new THREE.Group();
    caseGroup.position.set(-0.76, tableH, -0.44);
    caseGroup.rotation.y = 0.18;
    opsTableGroup.add(caseGroup);

    const caseBase = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.46, 0.12, 0.32)),
      oliveMetalMat,
    );
    caseBase.position.set(0, 0.06, 0);
    caseBase.castShadow = !isSoftwareGl;
    caseGroup.add(caseBase);
    raycastMeshes.push(caseBase);

    for (const lx of [-0.14, 0.14]) {
      const latch = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.045, 0.05, 0.022)),
        chassisBlackMat,
      );
      latch.position.set(lx, 0.07, 0.165);
      caseGroup.add(latch);
    }
    const caseHandle = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.14, 0.022, 0.035)),
      rubberBumperMat,
    );
    caseHandle.position.set(0, 0.055, 0.175);
    caseGroup.add(caseHandle);

    // Briefing dossier stack at South-East edge
    const dossier = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.24, 0.022, 0.31)),
      materials.missionPaper,
    );
    dossier.position.set(0.68, tableH + 0.011, 0.42);
    dossier.rotation.y = -0.28;
    opsTableGroup.add(dossier);

    // Table physics box
    physics.addBox({
      minX: tableX - tableW * 0.5,
      maxX: tableX + tableW * 0.5,
      minY: 0,
      maxY: tableH,
      minZ: tableZ - tableD * 0.5,
      maxZ: tableZ + tableD * 0.5,
      surface: 'metal',
    });

    // =========================================================================
    // 3. HERO PROP: RUGGEDIZED OPS COMMAND LAPTOP (LIVE SCREEN + DESTRUCTIBLE)
    // =========================================================================
    const laptopGroup = new THREE.Group();
    laptopGroup.position.set(0.58, tableH, 0.04); // world: (-10.82, 0.86, 0.04)
    laptopGroup.rotation.y = Math.PI * 0.5; // faces +X toward approaching operator from Arsenal doorway
    opsTableGroup.add(laptopGroup);

    // Armored base chassis (0.42m W x 0.034m H x 0.31m D)
    const laptopBase = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.42, 0.034, 0.31)),
      chassisBlackMat,
    );
    laptopBase.position.set(0, 0.017, 0);
    laptopBase.castShadow = !isSoftwareGl;
    laptopGroup.add(laptopBase);

    // Rubberized corner bumpers
    for (const bx of [-0.205, 0.205]) {
      for (const bz of [-0.15, 0.15]) {
        const bumper = new THREE.Mesh(
          trackGeo(new THREE.BoxGeometry(0.042, 0.038, 0.042)),
          rubberBumperMat,
        );
        bumper.position.set(bx, 0.019, bz);
        laptopGroup.add(bumper);
      }
    }

    // Backlit tactical keyboard deck
    const kbTex = trackTex(buildKeyboardDeckTexture(maxAniso));
    const kbMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: kbTex,
        emissiveMap: kbTex,
        emissive: new THREE.Color(0x60a5fa),
        emissiveIntensity: 0.24,
        roughness: 0.6,
        metalness: 0.25,
      }),
    );
    const keyboardDeck = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(0.36, 0.24)), kbMat);
    keyboardDeck.rotation.x = -Math.PI * 0.5;
    keyboardDeck.position.set(0, 0.0355, 0.012);
    laptopGroup.add(keyboardDeck);

    // Carry handle bar on front rim + brushed steel hinge barrel on rear rim
    const frontHandle = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.16, 0.018, 0.022)),
      rubberBumperMat,
    );
    frontHandle.position.set(0, 0.017, 0.168);
    laptopGroup.add(frontHandle);

    const hingeBarrel = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.012, 0.012, 0.34, 12)),
      materials.brushedSteel,
    );
    hingeBarrel.rotation.z = Math.PI * 0.5;
    hingeBarrel.position.set(0, 0.034, -0.142);
    laptopGroup.add(hingeBarrel);

    // Articulated Lid Pivot (open to ~108 deg)
    const lidPivot = new THREE.Group();
    lidPivot.position.set(0, 0.034, -0.142);
    lidPivot.rotation.x = -THREE.MathUtils.degToRad(18);
    laptopGroup.add(lidPivot);

    const lidShell = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.42, 0.29, 0.024)),
      chassisBlackMat,
    );
    lidShell.position.set(0, 0.145, -0.012);
    lidShell.castShadow = !isSoftwareGl;
    lidPivot.add(lidShell);

    // Rear ribbed reinforcement ridge on lid back
    const lidRib = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.32, 0.18, 0.012)),
      oliveMetalMat,
    );
    lidRib.position.set(0, 0.145, -0.026);
    lidPivot.add(lidRib);

    // Live 3D Ops Command Laptop Display CanvasTexture
    const [lapC, lapCtx] = makeCanvas(512, 320);
    this.laptopCanvas = lapC;
    this.laptopCtx = lapCtx;
    this.laptopTex = trackTex(new THREE.CanvasTexture(lapC));
    this.laptopTex.colorSpace = THREE.SRGBColorSpace;
    this.laptopTex.anisotropy = maxAniso;

    this.laptopScreenMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: this.laptopTex,
        emissiveMap: this.laptopTex,
        emissive: new THREE.Color(0xffffff),
        emissiveIntensity: 0.92,
        roughness: 0.18,
        metalness: 0.08,
      }),
    );
    const laptopScreenMesh = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(0.365, 0.232)),
      this.laptopScreenMat,
    );
    laptopScreenMesh.position.set(0, 0.148, 0.002);
    lidPivot.add(laptopScreenMesh);

    // Register Ops Command Laptop with HideoutElectronicsSystem
    electronics.registerNode(
      {
        id: 'ops_command_laptop',
        label: 'Ops Command Laptop',
        hitMeshes: [laptopBase, lidShell, lidRib, laptopScreenMesh],
        emissiveMeshes: [keyboardDeck],
        linkedLights: [{ light: laptopScreenLight, dropFraction: 1.0 }],
        sparkOrigin: new THREE.Vector3(-10.82, 1.02, 0.04),
        onBreak: () => {
          this.laptopBroken = true;
          this.laptopScreenMat.emissiveIntensity = 0.14;
          drawCrackedGlassOverlay(
            this.laptopCtx,
            this.laptopCanvas.width,
            this.laptopCanvas.height,
            'SIGNAL LOST',
            'TERMINAL DAMAGED · RELOAD',
          );
          this.laptopTex.needsUpdate = true;
        },
      },
      raycastMeshes,
    );

    // Interactable proxy covering the Ops Command Laptop
    const laptopProxy = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.68, 0.56, 0.68)),
      proxyMat,
    );
    laptopProxy.position.set(-10.82, tableH + 0.18, 0.04);
    laptopProxy.userData.hideoutInteractable = {
      kind: 'ops_laptop',
      maxDistanceM: 2.85,
    } satisfies HideoutInteractableMeta;
    readyGroup.add(laptopProxy);
    interactableMeshes.push(laptopProxy);

    // =========================================================================
    // 4. WEST WALL: ILLUMINATED TACTICAL BRIEFING BOARD + TWIN WALL MONITORS
    // =========================================================================
    const boardWallX = -16.44;
    const boardW = 4.35;
    const boardH = 1.78;
    const boardY = 1.84;

    const boardGroup = new THREE.Group();
    boardGroup.position.set(boardWallX, boardY, 0);
    boardGroup.rotation.y = Math.PI * 0.5;
    readyGroup.add(boardGroup);

    const boardFrame = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(boardW + 0.16, boardH + 0.16, 0.08)),
      materials.darkSteel,
    );
    boardGroup.add(boardFrame);
    raycastMeshes.push(boardFrame);

    const [brdC, brdCtx] = makeCanvas(1024, 512);
    this.boardCanvas = brdC;
    this.boardCtx = brdCtx;
    this.boardTex = trackTex(new THREE.CanvasTexture(brdC));
    this.boardTex.colorSpace = THREE.SRGBColorSpace;
    this.boardTex.anisotropy = maxAniso;

    const boardMat = trackMat(
      new THREE.MeshStandardMaterial({
        map: this.boardTex,
        emissiveMap: this.boardTex,
        emissive: new THREE.Color(0xdbeafe),
        emissiveIntensity: 0.28,
        roughness: 0.42,
        metalness: 0.08,
      }),
    );
    const boardFace = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(boardW, boardH)),
      boardMat,
    );
    boardFace.position.set(0, 0, 0.044);
    boardGroup.add(boardFace);
    raycastMeshes.push(boardFace);

    // Hooded overhead gallery light valance over the Briefing Board (destructible light fixture)
    const boardHood = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(boardW - 0.15, 0.06, 0.24)),
      materials.darkSteel,
    );
    boardHood.position.set(0, boardH * 0.5 + 0.16, 0.14);
    boardGroup.add(boardHood);

    const boardLampStrip = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(boardW - 0.35, 0.025, 0.06)),
      screenCoolLightMat,
    );
    boardLampStrip.position.set(0, boardH * 0.5 + 0.125, 0.2);
    boardGroup.add(boardLampStrip);

    electronics.registerNode(
      {
        id: 'ready_room_board_light',
        label: 'Briefing Board Light',
        hitMeshes: [boardHood, boardLampStrip],
        emissiveMeshes: [boardLampStrip],
        linkedLights: [{ light: boardWashLight, dropFraction: 1.0 }],
        sparkOrigin: new THREE.Vector3(boardWallX + 0.2, boardY + boardH * 0.5 + 0.12, 0),
        isLightFixture: true,
      },
      raycastMeshes,
    );

    // Interactable proxy on the Tactical Briefing Board
    const boardProxy = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.42, 1.85, 4.1)),
      proxyMat,
    );
    boardProxy.position.set(boardWallX + 0.22, boardY, 0);
    boardProxy.userData.hideoutInteractable = {
      kind: 'ops_briefing_board',
      maxDistanceM: 3.1,
    } satisfies HideoutInteractableMeta;
    readyGroup.add(boardProxy);
    interactableMeshes.push(boardProxy);

    // --- TWIN WALL-MOUNTED TELEMETRY MONITORS FLANKING THE BRIEFING BOARD ---
    const buildWallMonitor = (
      id: string,
      label: string,
      posZ: number,
      yawInward: number,
      onBreakCb: () => void,
    ): {
      canvas: HTMLCanvasElement;
      ctx: CanvasRenderingContext2D;
      tex: THREE.CanvasTexture;
      mat: THREE.MeshStandardMaterial;
    } => {
      const monGroup = new THREE.Group();
      monGroup.position.set(-16.12, 1.92, posZ);
      monGroup.rotation.y = Math.PI * 0.5 + yawInward;
      readyGroup.add(monGroup);

      // Articulated steel wall arm + swivel bracket
      const wallPlate = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.18, 0.24, 0.04)),
        materials.darkSteel,
      );
      wallPlate.position.set(0, 0, -0.32);
      monGroup.add(wallPlate);

      const armBeam = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.06, 0.06, 0.26)),
        materials.brushedSteel,
      );
      armBeam.position.set(0, 0, -0.18);
      monGroup.add(armBeam);

      // Monitor housing
      const housing = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(1.16, 0.72, 0.14)),
        chassisBlackMat,
      );
      housing.castShadow = !isSoftwareGl;
      monGroup.add(housing);

      const [mC, mCtx] = makeCanvas(512, 320);
      const mTex = trackTex(new THREE.CanvasTexture(mC));
      mTex.colorSpace = THREE.SRGBColorSpace;
      mTex.anisotropy = maxAniso;

      const mMat = trackMat(
        new THREE.MeshStandardMaterial({
          map: mTex,
          emissiveMap: mTex,
          emissive: new THREE.Color(0xffffff),
          emissiveIntensity: 0.78,
          roughness: 0.22,
          metalness: 0.08,
        }),
      );
      const screenPlane = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(1.04, 0.62)), mMat);
      screenPlane.position.set(0, 0, 0.072);
      monGroup.add(screenPlane);

      electronics.registerNode(
        {
          id,
          label,
          hitMeshes: [housing, screenPlane],
          emissiveMeshes: [],
          sparkOrigin: new THREE.Vector3(-16.0, 1.92, posZ),
          onBreak: onBreakCb,
        },
        raycastMeshes,
      );

      return { canvas: mC, ctx: mCtx, tex: mTex, mat: mMat };
    };

    const loadoutMon = buildWallMonitor(
      'ready_room_monitor_loadout',
      'Loadout Telemetry Monitor',
      -3.25,
      -0.22,
      () => {
        this.loadoutMonBroken = true;
        this.loadoutMonMat.emissiveIntensity = 0.14;
        drawCrackedGlassOverlay(
          this.loadoutMonCtx,
          this.loadoutMonCanvas.width,
          this.loadoutMonCanvas.height,
          'NO SIGNAL',
          'DISPLAY DAMAGED',
        );
        this.loadoutMonTex.needsUpdate = true;
      },
    );
    this.loadoutMonCanvas = loadoutMon.canvas;
    this.loadoutMonCtx = loadoutMon.ctx;
    this.loadoutMonTex = loadoutMon.tex;
    this.loadoutMonMat = loadoutMon.mat;

    const commsMon = buildWallMonitor(
      'ready_room_monitor_comms',
      'Comms & Weather Monitor',
      3.25,
      0.22,
      () => {
        this.commsMonBroken = true;
        this.commsMonMat.emissiveIntensity = 0.14;
        drawCrackedGlassOverlay(
          this.commsMonCtx,
          this.commsMonCanvas.width,
          this.commsMonCanvas.height,
          'LINK DOWN',
          'DISPLAY DAMAGED',
        );
        this.commsMonTex.needsUpdate = true;
      },
    );
    this.commsMonCanvas = commsMon.canvas;
    this.commsMonCtx = commsMon.ctx;
    this.commsMonTex = commsMon.tex;
    this.commsMonMat = commsMon.mat;

    // =========================================================================
    // 5. NORTH WALL: 19" COMMS RACK, FIELD RADIO TRANSCEIVER & GEAR BENCH
    // =========================================================================
    const rackX = -13.6;
    const rackZ = -4.55;
    const rackGroup = new THREE.Group();
    rackGroup.position.set(rackX, 0, rackZ);
    readyGroup.add(rackGroup);

    const rackBody = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.92, 2.18, 0.72)),
      materials.darkSteel,
    );
    rackBody.position.set(0, 1.09, 0);
    rackBody.castShadow = !isSoftwareGl;
    rackBody.receiveShadow = true;
    rackGroup.add(rackBody);

    // Stacked rackmount radio/patchbay faceplates
    const radioFaceMeshes: THREE.Mesh[] = [];
    for (let u = 0; u < 5; u++) {
      const bay = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.8, 0.24, 0.04)),
        u === 2 ? radioFaceEmissiveMat : chassisBlackMat,
      );
      bay.position.set(0, 0.44 + u * 0.34, 0.365);
      rackGroup.add(bay);
      if (u === 2) radioFaceMeshes.push(bay);

      // Knobs & handle loops on each rack unit
      for (const kx of [-0.32, 0.32]) {
        const knob = new THREE.Mesh(
          trackGeo(new THREE.CylinderGeometry(0.018, 0.018, 0.03, 10)),
          materials.brushedSteel,
        );
        knob.rotation.x = Math.PI * 0.5;
        knob.position.set(kx, 0.44 + u * 0.34, 0.39);
        rackGroup.add(knob);
      }
    }

    // Twin vertical tactical whip antennas atop the comms rack
    for (const ax of [-0.28, 0.28]) {
      const whip = new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.006, 0.011, 0.95, 8)),
        materials.brushedSteel,
      );
      whip.position.set(ax, 2.65, -0.1);
      rackGroup.add(whip);
    }

    electronics.registerNode(
      {
        id: 'ready_room_radio',
        label: 'Encrypted Comms Rack',
        hitMeshes: [rackBody, ...radioFaceMeshes],
        emissiveMeshes: radioFaceMeshes,
        sparkOrigin: new THREE.Vector3(rackX, 1.25, rackZ + 0.42),
        onBreak: () => {
          this.radioBroken = true;
          this.redrawCommsMonitor();
        },
      },
      raycastMeshes,
    );

    physics.addBox({
      minX: rackX - 0.5,
      maxX: rackX + 0.5,
      minY: 0,
      maxY: 2.2,
      minZ: rackZ - 0.4,
      maxZ: rackZ + 0.4,
      surface: 'metal',
    });

    // North-East Tactical Gear Bench & Staged Transit Crates
    const addSquadBench = (bx: number, bz: number, bw: number): void => {
      const bGroup = new THREE.Group();
      bGroup.position.set(bx, 0, bz);
      readyGroup.add(bGroup);

      const plank = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(bw, 0.055, 0.46)),
        materials.tableWood,
      );
      plank.position.set(0, 0.46, 0);
      plank.castShadow = !isSoftwareGl;
      plank.receiveShadow = true;
      bGroup.add(plank);
      raycastMeshes.push(plank);

      for (const lx of [-bw * 0.42, bw * 0.42]) {
        const bLeg = new THREE.Mesh(
          trackGeo(new THREE.BoxGeometry(0.06, 0.44, 0.4)),
          materials.darkSteel,
        );
        bLeg.position.set(lx, 0.22, 0);
        bGroup.add(bLeg);
      }

      physics.addBox({
        minX: bx - bw * 0.5,
        maxX: bx + bw * 0.5,
        minY: 0,
        maxY: 0.49,
        minZ: bz - 0.25,
        maxZ: bz + 0.25,
        surface: 'wood',
      });
    };

    addSquadBench(-9.2, -4.45, 2.8);
    addSquadBench(-11.4, 4.45, 4.2);

    // Tactical helmet & transit crates resting on North bench
    const transitCrate = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.62, 0.34, 0.38)),
      materials.ammoCrateBody,
    );
    transitCrate.position.set(-9.9, 0.66, -4.44);
    transitCrate.rotation.y = 0.08;
    transitCrate.castShadow = !isSoftwareGl;
    readyGroup.add(transitCrate);
    raycastMeshes.push(transitCrate);

    const benchHelmet = new THREE.Mesh(
      trackGeo(new THREE.SphereGeometry(0.14, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.62)),
      oliveMetalMat,
    );
    benchHelmet.position.set(-8.55, 0.5, -4.42);
    readyGroup.add(benchHelmet);

    // =========================================================================
    // 6. BRIEFING CHAIRS AROUND OPS TABLE + CORRIDOR DEPLOYMENT STATUS BEACON
    // =========================================================================
    const addBriefingChair = (cx: number, cz: number, yaw: number): void => {
      const ch = new THREE.Group();
      ch.position.set(cx, 0, cz);
      ch.rotation.y = yaw;
      readyGroup.add(ch);

      const seat = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.46, 0.045, 0.44)),
        rubberBumperMat,
      );
      seat.position.set(0, 0.46, 0);
      seat.castShadow = !isSoftwareGl;
      ch.add(seat);

      const backRest = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.44, 0.34, 0.04)),
        rubberBumperMat,
      );
      backRest.position.set(0, 0.72, -0.2);
      ch.add(backRest);

      const backPost = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.05, 0.32, 0.03)),
        materials.darkSteel,
      );
      backPost.position.set(0, 0.56, -0.21);
      ch.add(backPost);

      for (const lx of [-0.19, 0.19]) {
        for (const lz of [-0.18, 0.18]) {
          const cLeg = new THREE.Mesh(
            trackGeo(new THREE.CylinderGeometry(0.015, 0.015, 0.46, 8)),
            materials.darkSteel,
          );
          cLeg.position.set(lx, 0.23, lz);
          ch.add(cLeg);
        }
      }
    };

    // Place 3 tucked briefing chairs on North & South flanks (keeping East & West walking lanes open!)
    addBriefingChair(-12.05, -1.16, 0.12);
    addBriefingChair(-10.85, -1.2, -0.18);
    addBriefingChair(-11.45, 1.18, Math.PI + 0.1);

    // Wall-mounted Deployment Status Beacon over East Entryway inside Ready Room
    const beaconHousing = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.12, 0.18, 0.42)),
      materials.darkSteel,
    );
    beaconHousing.position.set(-6.58, 3.06, 0);
    readyGroup.add(beaconHousing);

    const beaconLens = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.04, 0.11, 0.32)),
      statusBeaconMat,
    );
    beaconLens.position.set(-6.64, 3.06, 0);
    readyGroup.add(beaconLens);

    electronics.registerNode(
      {
        id: 'ready_room_status_beacon',
        label: 'Deployment Status Beacon',
        hitMeshes: [beaconHousing, beaconLens],
        emissiveMeshes: [beaconLens],
        sparkOrigin: new THREE.Vector3(-6.66, 3.04, 0),
        isLightFixture: true,
      },
      raycastMeshes,
    );

    // Initial render of all 4 live Ready Room displays
    this.redrawAllDisplays();
  }

  public isLaptopBroken(): boolean {
    return this.laptopBroken;
  }

  public getLaptopWorldPos(out: THREE.Vector3): boolean {
    out.copy(this.laptopWorldPos);
    return true;
  }

  public getBoardWorldPos(out: THREE.Vector3): boolean {
    out.copy(this.boardWorldPos);
    return true;
  }

  public setBriefingState(next: ReadyRoomBriefingState): void {
    const prevOw = this.briefing.openWorldCharacter;
    const nextOw = next.openWorldCharacter;
    const owChanged =
      prevOw?.slotId !== nextOw?.slotId ||
      prevOw?.callsign !== nextOw?.callsign ||
      prevOw?.shardMode !== nextOw?.shardMode ||
      prevOw?.factionName !== nextOw?.factionName ||
      prevOw?.bodyTypeLabel !== nextOw?.bodyTypeLabel ||
      prevOw?.cashUsd !== nextOw?.cashUsd ||
      prevOw?.respawnFeeUsd !== nextOw?.respawnFeeUsd ||
      prevOw?.isBankruptcyRisk !== nextOw?.isBankruptcyRisk ||
      prevOw?.ownedWeaponCount !== nextOw?.ownedWeaponCount;

    const changed =
      owChanged ||
      next.mapId !== this.briefing.mapId ||
      next.ruleLabel !== this.briefing.ruleLabel ||
      next.botCount !== this.briefing.botCount ||
      next.killLimit !== this.briefing.killLimit ||
      next.difficultyLabel !== this.briefing.difficultyLabel ||
      next.weatherLabel !== this.briefing.weatherLabel ||
      next.timeOfDayLabel !== this.briefing.timeOfDayLabel ||
      next.primaryWeaponName !== this.briefing.primaryWeaponName ||
      next.secondaryWeaponName !== this.briefing.secondaryWeaponName ||
      next.grenadeName !== this.briefing.grenadeName ||
      next.operatorLabel !== this.briefing.operatorLabel ||
      next.rankLabel !== this.briefing.rankLabel ||
      next.lobbyCode !== this.briefing.lobbyCode ||
      next.lobbyMembersCount !== this.briefing.lobbyMembersCount;

    if (!changed) return;
    this.briefing = {
      ...next,
      openWorldCharacter: nextOw ? { ...nextOw } : null,
    };
    this.redrawAllDisplays();
  }

  public update(dt: number): void {
    this.animTime += dt;
    if (!this.commsMonBroken && !this.radioBroken) {
      this.commsRedrawAccum += dt;
      if (this.commsRedrawAccum >= 0.22) {
        this.commsRedrawAccum = 0;
        this.redrawCommsMonitor();
      }
    }
  }

  private redrawAllDisplays(): void {
    this.redrawLaptopScreen();
    this.redrawBriefingBoard();
    this.redrawLoadoutMonitor();
    this.redrawCommsMonitor();
  }

  private redrawLaptopScreen(): void {
    if (this.laptopBroken) return;
    const ctx = this.laptopCtx;
    const w = this.laptopCanvas.width;
    const h = this.laptopCanvas.height;
    const b = this.briefing;

    ctx.fillStyle = '#090d12';
    ctx.fillRect(0, 0, w, h);

    const ow = b.openWorldCharacter;

    // Top bar
    ctx.fillStyle = '#111822';
    ctx.fillRect(0, 0, w, 40);
    ctx.fillStyle = ow?.isBankruptcyRisk ? '#ef4444' : '#38bdf8';
    ctx.fillRect(0, 38, w, 2);

    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 17px "IBM Plex Mono", monospace';
    ctx.fillText(ow ? 'PERIMETER OPS TERMINAL' : 'OPS COMMAND TERMINAL', 16, 26);

    ctx.textAlign = 'right';
    ctx.fillStyle = ow
      ? ow.isBankruptcyRisk
        ? '#f87171'
        : '#34d399'
      : b.lobbyCode
        ? '#38bdf8'
        : '#f59e0b';
    ctx.font = '600 13px "IBM Plex Mono", monospace';
    ctx.fillText(
      ow
        ? `${ow.shardMode} · ${ow.factionShort}`
        : b.lobbyCode
          ? `SQUAD ${b.lobbyCode}`
          : 'SOLO STAGED',
      w - 16,
      25,
    );
    ctx.textAlign = 'left';

    // Sector or Active Character panel
    ctx.fillStyle = ow?.isBankruptcyRisk ? '#1b0f12' : '#10161e';
    ctx.fillRect(16, 54, w - 32, 92);
    ctx.strokeStyle = ow?.isBankruptcyRisk
      ? 'rgba(248, 113, 113, 0.7)'
      : 'rgba(56, 189, 248, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(16, 54, w - 32, 92);

    if (ow) {
      ctx.fillStyle = ow.isBankruptcyRisk ? '#fca5a5' : '#7dd3fc';
      ctx.font = '600 12px "IBM Plex Mono", monospace';
      ctx.fillText(
        ow.isBankruptcyRisk
          ? 'BANKRUPTCY WARNING · DEATH WIPES CHARACTER'
          : `ACTIVE ROSTER OPERATOR · TIER ${ow.progressionTier}`,
        28,
        76,
      );

      ctx.fillStyle = '#f8fafc';
      ctx.font = '700 24px "IBM Plex Mono", monospace';
      ctx.fillText(ow.callsign.toUpperCase().slice(0, 22), 28, 108);

      ctx.fillStyle = '#cbd5e1';
      ctx.font = '500 13px "IBM Plex Mono", monospace';
      ctx.fillText(
        `CASH $${ow.cashUsd.toLocaleString()} · MEDEVAC $${ow.respawnFeeUsd.toLocaleString()} · ${ow.ownedWeaponCount} WALL GUNS`,
        28,
        132,
      );
    } else {
      ctx.fillStyle = '#7dd3fc';
      ctx.font = '600 12px "IBM Plex Mono", monospace';
      ctx.fillText('STAGED COMBAT SECTOR', 28, 76);

      ctx.fillStyle = '#f8fafc';
      ctx.font = '700 24px "IBM Plex Mono", monospace';
      ctx.fillText(b.mapName.toUpperCase().slice(0, 24), 28, 108);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '500 13px "IBM Plex Mono", monospace';
      ctx.fillText(`${b.ruleLabel} · ${b.botCount} Bots · ${b.killLimit} Kills`, 28, 132);
    }

    // Telemetry grid
    const rowY = 164;
    ctx.fillStyle = '#0f141b';
    ctx.fillRect(16, rowY, 232, 86);
    ctx.fillRect(264, rowY, 232, 86);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
    ctx.strokeRect(16, rowY, 232, 86);
    ctx.strokeRect(264, rowY, 232, 86);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 11px "IBM Plex Mono", monospace';
    ctx.fillText('ACTIVE LOADOUT', 28, rowY + 20);
    ctx.fillStyle = '#f1f5f9';
    ctx.font = '600 14px "IBM Plex Mono", monospace';
    ctx.fillText(b.primaryWeaponName.slice(0, 20), 28, rowY + 44);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '500 12px "IBM Plex Mono", monospace';
    ctx.fillText(`${b.secondaryWeaponName.slice(0, 14)} · ${b.grenadeName}`, 28, rowY + 68);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 11px "IBM Plex Mono", monospace';
    ctx.fillText(ow ? 'FACTION · RIG' : 'CONDITIONS', 276, rowY + 20);
    ctx.fillStyle = '#fbbf24';
    ctx.font = '600 14px "IBM Plex Mono", monospace';
    ctx.fillText(
      ow ? `${ow.factionName} · ${ow.bodyTypeLabel}` : `${b.weatherLabel} · ${b.timeOfDayLabel}`,
      276,
      rowY + 44,
    );
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '500 12px "IBM Plex Mono", monospace';
    ctx.fillText(
      ow ? `${ow.shardLabel.slice(0, 26)}` : `AI ${b.difficultyLabel} · ${b.rankLabel}`,
      276,
      rowY + 68,
    );

    // Bottom action banner
    ctx.fillStyle = ow?.isBankruptcyRisk ? '#dc2626' : '#f59e0b';
    ctx.fillRect(16, 266, w - 32, 38);
    ctx.fillStyle = ow?.isBankruptcyRisk ? '#fef2f2' : '#090a0b';
    ctx.textAlign = 'center';
    ctx.font = '700 15px "IBM Plex Mono", monospace';
    ctx.fillText(
      ow?.isBankruptcyRisk
        ? '[F] OPEN ROSTER · BANKRUPTCY RISK ACTIVE'
        : '[F] OPEN OPS TERMINAL · ROSTER & DEPLOY',
      w * 0.5,
      290,
    );
    ctx.textAlign = 'left';

    this.laptopTex.needsUpdate = true;
  }

  private redrawBriefingBoard(): void {
    const ctx = this.boardCtx;
    const w = this.boardCanvas.width;
    const h = this.boardCanvas.height;
    const b = this.briefing;

    // Dark tactical slate board
    ctx.fillStyle = '#0c1116';
    ctx.fillRect(0, 0, w, h);

    // Subtle MGRS grid across left tactical map zone
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.11)';
    ctx.lineWidth = 1;
    for (let x = 32; x < 640; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x, 66);
      ctx.lineTo(x, h - 32);
      ctx.stroke();
    }
    for (let y = 66; y < h - 24; y += 48) {
      ctx.beginPath();
      ctx.moveTo(32, y);
      ctx.lineTo(640, y);
      ctx.stroke();
    }

    // Header band
    ctx.fillStyle = '#131b24';
    ctx.fillRect(0, 0, w, 56);
    ctx.fillStyle = '#60a5fa';
    ctx.fillRect(0, 54, w, 2);

    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 24px "IBM Plex Mono", monospace';
    ctx.fillText(`SECTOR BRIEFING · ${b.mapName.toUpperCase()}`, 28, 37);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#fbbf24';
    ctx.font = '600 18px "IBM Plex Mono", monospace';
    ctx.fillText(b.ruleLabel.toUpperCase(), w - 28, 36);
    ctx.textAlign = 'left';

    // Map-specific schematic blueprint on left (x: 36..628, y: 74..476)
    ctx.strokeStyle = 'rgba(96, 165, 250, 0.32)';
    ctx.lineWidth = 2;
    ctx.strokeRect(36, 74, 592, 402);

    if (b.mapId === 'timber_valley') {
      // Winding river + airstrip + radar + villages
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
      ctx.lineWidth = 18;
      ctx.beginPath();
      ctx.moveTo(40, 360);
      ctx.bezierCurveTo(210, 310, 390, 405, 624, 305);
      ctx.stroke();

      ctx.fillStyle = 'rgba(148, 163, 184, 0.25)';
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 2;
      ctx.fillRect(280, 112, 290, 54);
      ctx.strokeRect(280, 112, 290, 54);
      ctx.fillStyle = '#f59e0b';
      for (let rx = 296; rx <= 556; rx += 32) {
        ctx.fillRect(rx, 115, 6, 4);
        ctx.fillRect(rx, 159, 6, 4);
      }
      ctx.fillStyle = 'rgba(74, 222, 128, 0.22)';
      ctx.strokeStyle = '#86efac';
      ctx.fillRect(88, 134, 96, 62);
      ctx.strokeRect(88, 134, 96, 62);
      ctx.beginPath();
      ctx.arc(520, 232, 34, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (b.mapId === 'korsakov_substation') {
      // Turbine hall + three colossal drums + switchyard
      ctx.fillStyle = 'rgba(30, 41, 59, 0.72)';
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 2.5;
      ctx.fillRect(72, 128, 336, 250);
      ctx.strokeRect(72, 128, 336, 250);
      ctx.setLineDash([10, 8]);
      ctx.strokeRect(430, 128, 164, 250);
      ctx.setLineDash([]);

      ctx.strokeStyle = '#f59e0b';
      ctx.fillStyle = 'rgba(245, 158, 11, 0.18)';
      for (const cx of [146, 240, 334]) {
        ctx.beginPath();
        ctx.arc(cx, 253, 36, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    } else {
      // Pripyat U-shaped Soviet microdistrict courtyard
      ctx.fillStyle = 'rgba(45, 74, 76, 0.55)';
      ctx.strokeStyle = '#5eead4';
      ctx.lineWidth = 2.5;
      ctx.fillRect(86, 114, 118, 304);
      ctx.strokeRect(86, 114, 118, 304);
      ctx.fillRect(460, 114, 118, 304);
      ctx.strokeRect(460, 114, 118, 304);
      ctx.fillRect(204, 114, 256, 86);
      ctx.strokeRect(204, 114, 256, 86);

      // Courtyard vehicles & sightlines
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.75)';
      ctx.lineWidth = 2;
      ctx.strokeRect(256, 260, 46, 22);
      ctx.strokeRect(360, 326, 52, 22);
    }

    // Team A / Team B tactical spawn markers
    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(132, 392, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#090d12';
    ctx.font = '700 13px "IBM Plex Mono", monospace';
    ctx.fillText('A', 127, 397);

    ctx.fillStyle = '#f97316';
    ctx.beginPath();
    ctx.arc(522, 166, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#090d12';
    ctx.fillText('B', 517, 171);

    // Right-hand mission dossier column (x: 656..996)
    ctx.fillStyle = '#111720';
    ctx.fillRect(656, 74, 340, 402);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.26)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(656, 74, 340, 402);

    const drawRow = (y: number, k: string, v: string, accent = '#f8fafc') => {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '600 13px "IBM Plex Mono", monospace';
      ctx.fillText(k, 676, y);
      ctx.fillStyle = accent;
      ctx.font = '700 19px "IBM Plex Mono", monospace';
      ctx.fillText(v.slice(0, 24), 676, y + 25);
    };

    drawRow(112, 'ENVIRONMENT', b.mapSubtitle);
    drawRow(178, 'WEATHER · TIME', `${b.weatherLabel} · ${b.timeOfDayLabel}`, '#fbbf24');
    drawRow(244, 'COMBATANTS', `${b.botCount} Bots · ${b.difficultyLabel} · ${b.killLimit} Kills`);
    drawRow(310, 'PRIMARY · SIDEARM', `${b.primaryWeaponName}`, '#e2e8f0');
    drawRow(
      376,
      'SQUAD STATUS',
      b.lobbyCode
        ? `LOBBY ${b.lobbyCode} (${b.lobbyMembersCount}/${b.lobbyMaxPlayers})`
        : 'SOLO DEPLOYMENT READY',
      b.lobbyCode ? '#38bdf8' : '#4ade80',
    );

    ctx.fillStyle = '#1e293b';
    ctx.fillRect(676, 424, 300, 34);
    ctx.fillStyle = '#93c5fd';
    ctx.font = '600 13px "IBM Plex Mono", monospace';
    ctx.fillText('[F] CYCLE SECTOR / OPS TERMINAL', 690, 446);

    this.boardTex.needsUpdate = true;
  }

  private redrawLoadoutMonitor(): void {
    if (this.loadoutMonBroken) return;
    const ctx = this.loadoutMonCtx;
    const w = this.loadoutMonCanvas.width;
    const h = this.loadoutMonCanvas.height;
    const b = this.briefing;

    ctx.fillStyle = '#0a0e12';
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#131a22';
    ctx.fillRect(0, 0, w, 44);
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(0, 42, w, 2);

    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 18px "IBM Plex Mono", monospace';
    ctx.fillText('OPERATOR KIT VERIFICATION', 18, 29);

    const drawField = (y: number, label: string, val: string, color = '#f1f5f9') => {
      ctx.fillStyle = '#64748b';
      ctx.font = '600 12px "IBM Plex Mono", monospace';
      ctx.fillText(label, 22, y);
      ctx.fillStyle = color;
      ctx.font = '700 20px "IBM Plex Mono", monospace';
      ctx.fillText(val.slice(0, 26), 22, y + 26);
    };

    const ow = b.openWorldCharacter;
    if (ow) {
      drawField(
        78,
        'ROSTER OPERATOR · SHARD',
        `${ow.callsign} · ${ow.shardMode}`,
        '#fef3c7',
      );
      drawField(
        142,
        'PMC FACTION · BODY RIG',
        `${ow.factionName} · ${ow.bodyTypeLabel}`,
        '#7dd3fc',
      );
      drawField(
        206,
        'ARSENAL WALL · LIQUID CASH',
        `${ow.ownedWeaponCount} Firearms · $${ow.cashUsd.toLocaleString()}`,
        ow.isBankruptcyRisk ? '#f87171' : '#34d399',
      );
      drawField(
        268,
        'MEDEVAC STATUS',
        ow.isBankruptcyRisk
          ? `BANKRUPTCY RISK ($${ow.respawnFeeUsd.toLocaleString()})`
          : `COVERED · FEE $${ow.respawnFeeUsd.toLocaleString()}`,
        ow.isBankruptcyRisk ? '#fca5a5' : '#cbd5e1',
      );
    } else {
      drawField(78, 'PRIMARY FIREARM', b.primaryWeaponName, '#fef3c7');
      drawField(142, 'SECONDARY SIDEARM', b.secondaryWeaponName, '#e2e8f0');
      drawField(206, 'BELT ORDNANCE', b.grenadeName, '#7dd3fc');
      drawField(268, 'OPERATOR RIG · RANK', `${b.operatorLabel} · ${b.rankLabel}`, '#cbd5e1');
    }

    this.loadoutMonTex.needsUpdate = true;
  }

  private redrawCommsMonitor(): void {
    if (this.commsMonBroken) return;
    const ctx = this.commsMonCtx;
    const w = this.commsMonCanvas.width;
    const h = this.commsMonCanvas.height;
    const b = this.briefing;

    ctx.fillStyle = '#090d11';
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#111820';
    ctx.fillRect(0, 0, w, 44);
    ctx.fillStyle = this.radioBroken ? '#ef4444' : '#38bdf8';
    ctx.fillRect(0, 42, w, 2);

    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 18px "IBM Plex Mono", monospace';
    ctx.fillText('COMMS & METEO TELEMETRY', 18, 29);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 13px "IBM Plex Mono", monospace';
    ctx.fillText('RADIO UPLINK', 22, 78);
    ctx.fillStyle = this.radioBroken ? '#f87171' : '#4ade80';
    ctx.font = '700 20px "IBM Plex Mono", monospace';
    ctx.fillText(
      this.radioBroken
        ? 'TRANSCEIVER OFFLINE'
        : b.lobbyCode
          ? `SQUAD NET ${b.lobbyCode}`
          : 'ENCRYPTED STANDBY',
      22,
      104,
    );

    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 13px "IBM Plex Mono", monospace';
    ctx.fillText('SECTOR WEATHER · CLOCK', 22, 146);
    ctx.fillStyle = '#fbbf24';
    ctx.font = '700 20px "IBM Plex Mono", monospace';
    ctx.fillText(`${b.weatherLabel} · ${b.timeOfDayLabel}`, 22, 172);

    // Radio waveform oscilloscope trace box
    ctx.fillStyle = '#0d141b';
    ctx.fillRect(20, 198, w - 40, 96);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.28)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(20, 198, w - 40, 96);

    ctx.strokeStyle = this.radioBroken ? '#ef4444' : '#38bdf8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const midY = 246;
    for (let i = 0; i <= 48; i++) {
      const px = 28 + (i / 48) * (w - 56);
      const amp = this.radioBroken
        ? 1.5
        : Math.sin(i * 0.45 + this.animTime * 4.2) * 18 +
          Math.cos(i * 1.1 - this.animTime * 7.1) * 9;
      const py = midY + amp;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    this.commsMonTex.needsUpdate = true;
  }

  public dispose(): void {
    for (const g of this.ownedGeos) g.dispose();
    for (const m of this.ownedMats) m.dispose();
    for (const t of this.ownedTexs) t.dispose();
  }
}

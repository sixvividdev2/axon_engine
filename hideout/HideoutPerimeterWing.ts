import * as THREE from 'three';
import { BodycamPhysicsWorld } from '../bodycam-sdk';
import { HideoutMaterialLibrary } from './HideoutMaterials';
import type { HideoutInteractableMeta } from './HideoutBunkerWorld';
import type { CharacterRosterState, CharacterSlotId } from '../src/modes/openworld';
import { computeFieldHospitalFee, PMC_FACTIONS } from '../src/modes/openworld';

interface AlcovePlaqueHandle {
  slotId: CharacterSlotId;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  stripMat: THREE.MeshStandardMaterial;
}

/**
 * Dedicated Perimeter Ops Wing connected off the Ready Room North wall
 * (`X ∈ [-16.5, -6.5], Z ∈ [-14.5, -5.5], H = 3.8m`).
 *
 * Physicalizes:
 * - 3 Illuminated Roster Operator Alcoves (Slot 1–3) with live status plaques & plinths
 * - Quartermaster Logistics Counter (West wall)
 * - Contract Officer Sector Dispatch Desk (East wall)
 * - Reinforced Helipad Access Hatch (East-North bulkhead → Helicopter Insertion)
 */
export class HideoutPerimeterWing {
  public readonly group = new THREE.Group();
  private readonly ownedGeos: THREE.BufferGeometry[] = [];
  private readonly ownedMats: THREE.Material[] = [];
  private readonly ownedTexs: THREE.Texture[] = [];
  private readonly plaques: AlcovePlaqueHandle[] = [];

  private readonly heliHatchPos = new THREE.Vector3(-6.78, 1.35, -12.1);
  private readonly quartermasterPos = new THREE.Vector3(-15.15, 1.05, -8.85);
  private readonly dispatchDeskPos = new THREE.Vector3(-7.75, 1.05, -9.15);
  private readonly heliBeaconMat: THREE.MeshStandardMaterial;
  private animTime = 0;

  constructor(
    root: THREE.Group,
    physics: BodycamPhysicsWorld,
    materials: HideoutMaterialLibrary,
    raycastMeshes: THREE.Object3D[],
    interactableMeshes: THREE.Mesh[],
    isSoftwareGl: boolean,
    maxAniso: number,
  ) {
    this.group.name = 'HideoutPerimeterOpsWing';
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
      this.ownedTexs.push(t);
      return t;
    };

    const proxyMat = trackMat(new THREE.MeshBasicMaterial({ visible: false }));
    const H = 3.8;

    const addBox = (
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      mat: THREE.Material,
      surface: 'concrete' | 'metal' | 'wood' = 'concrete',
      collides = true,
    ): THREE.Mesh => {
      const m = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(w, h, d)), mat);
      m.position.set(x, y, z);
      m.receiveShadow = true;
      m.castShadow = !isSoftwareGl && h < 3.0;
      m.userData.surfaceMaterial = surface;
      this.group.add(m);
      raycastMeshes.push(m);
      if (collides) {
        physics.addBox({
          minX: x - w * 0.5,
          maxX: x + w * 0.5,
          minY: y - h * 0.5,
          maxY: y + h * 0.5,
          minZ: z - d * 0.5,
          maxZ: z + d * 0.5,
          surface,
        });
      }
      return m;
    };

    // =========================================================================
    // 1. ARCHITECTURAL SHELL (X ∈ [-16.5, -6.5], Z ∈ [-14.5, -5.5])
    // =========================================================================
    addBox(-11.5, -0.1, -10.0, 10.6, 0.2, 9.6, materials.concreteFloor, 'concrete', false);
    const ceil = addBox(-11.5, H + 0.1, -10.0, 10.6, 0.2, 9.6, materials.concreteCeiling, 'concrete', true);
    ceil.userData.isRoof = true;

    // West, East, and North perimeter walls
    addBox(-16.75, H * 0.5, -10.0, 0.5, H, 9.6, materials.concreteWall, 'concrete');
    addBox(-6.25, H * 0.5, -10.0, 0.5, H, 9.6, materials.concreteWall, 'concrete');
    addBox(-11.5, H * 0.5, -14.75, 10.6, H, 0.5, materials.concreteWall, 'concrete');

    // Wing illumination (zero shadow casters — stays cleanly within ≤ 2 scene shadow budget)
    const wingLight = new THREE.PointLight(0xd1fae5, 6.2, 16, 1.4);
    wingLight.position.set(-11.5, 3.25, -9.8);
    this.group.add(wingLight);

    const alcoveWash = new THREE.PointLight(0xa7f3d0, 4.4, 11, 1.5);
    alcoveWash.position.set(-11.5, 2.95, -12.6);
    this.group.add(alcoveWash);

    // Ceiling structural ribs & overhead plaque inside Wing
    for (const bx of [-14.2, -11.5, -8.8]) {
      const beam = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.22, 0.24, 9.0)),
        materials.darkSteel,
      );
      beam.position.set(bx, H - 0.12, -10.0);
      this.group.add(beam);
    }

    const wingBannerMat = materials.createSignMaterial(
      'PERIMETER OPS WING',
      'ROSTER ALCOVES · QUARTERMASTER · HELIPAD',
      '#10b981',
    );
    const wingBanner = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(2.8, 0.44, 0.05)), wingBannerMat);
    wingBanner.position.set(-11.5, 3.36, -14.46);
    this.group.add(wingBanner);

    // =========================================================================
    // 2. THREE PHYSICAL ROSTER OPERATOR ALCOVES (NORTH WALL Z = -13.6)
    // =========================================================================
    const slotDefs: Array<{ slotId: CharacterSlotId; x: number; index: number }> = [
      { slotId: 'slot_0', x: -14.2, index: 1 },
      { slotId: 'slot_1', x: -11.5, index: 2 },
      { slotId: 'slot_2', x: -8.8, index: 3 },
    ];

    const alcoveBackMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x161b20,
        roughness: 0.72,
        metalness: 0.32,
      }),
    );

    for (const sd of slotDefs) {
      // Raised steel staging plinth (top Y = 0.12m where the 3D Roster Operator stands)
      addBox(sd.x, 0.06, -13.18, 2.05, 0.12, 1.55, materials.darkSteel, 'metal', false);
      // Recessed rear steel alcove backdrop + flanking divider fins
      addBox(sd.x, 1.38, -14.38, 2.1, 2.65, 0.12, alcoveBackMat, 'metal', true);
      addBox(sd.x - 1.08, 1.35, -13.45, 0.12, 2.6, 1.85, materials.darkSteel, 'metal', true);
      addBox(sd.x + 1.08, 1.35, -13.45, 0.12, 2.6, 1.85, materials.darkSteel, 'metal', true);

      // Overhead alcove LED strip
      const stripMat = trackMat(
        new THREE.MeshStandardMaterial({
          color: 0xd1fae5,
          emissive: new THREE.Color(0x10b981),
          emissiveIntensity: 1.6,
          roughness: 0.25,
        }),
      );
      const ledBar = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.72, 0.04, 0.09)), stripMat);
      ledBar.position.set(sd.x, 2.64, -13.15);
      this.group.add(ledBar);

      // Live CanvasTexture Status Plaque above each alcove
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 160;
      const ctx = canvas.getContext('2d')!;
      const tex = trackTex(new THREE.CanvasTexture(canvas));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = maxAniso;

      const plaqueMat = trackMat(
        new THREE.MeshStandardMaterial({
          map: tex,
          emissiveMap: tex,
          emissive: new THREE.Color(0xffffff),
          emissiveIntensity: 0.55,
          roughness: 0.35,
          metalness: 0.1,
        }),
      );
      const plaqueMesh = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(1.88, 0.56)), plaqueMat);
      plaqueMesh.position.set(sd.x, 2.94, -12.6);
      this.group.add(plaqueMesh);

      // Interactable proxy covering the alcove pedestal (works even when slot is empty so player can recruit!)
      const alcoveProxy = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.6, 1.9, 1.3)), proxyMat);
      alcoveProxy.position.set(sd.x, 1.05, -13.1);
      alcoveProxy.userData.hideoutInteractable = {
        kind: 'perimeter_roster_alcove',
        slotIndex: sd.index - 1,
        maxDistanceM: 3.1,
      } satisfies HideoutInteractableMeta;
      this.group.add(alcoveProxy);
      interactableMeshes.push(alcoveProxy);

      this.plaques.push({ slotId: sd.slotId, canvas, ctx, tex, stripMat });
    }

    // =========================================================================
    // 3. QUARTERMASTER LOGISTICS COUNTER (WEST WALL X = -15.4, Z = -8.85)
    // =========================================================================
    addBox(-15.55, 0.48, -8.85, 0.92, 0.96, 2.7, materials.darkSteel, 'metal', true);
    addBox(-15.55, 0.98, -8.85, 0.98, 0.06, 2.78, materials.tableWood, 'wood', false);
    // Stacked olive logistics pelicans behind Quartermaster
    addBox(-16.1, 0.34, -7.6, 0.62, 0.56, 0.84, materials.ammoCrateBody, 'metal', true);
    addBox(-16.1, 0.34, -10.1, 0.62, 0.56, 0.84, materials.ammoCrateBody, 'metal', true);
    const qmSignMat = materials.createSignMaterial('QUARTERMASTER', 'ARMORY STASH · PLATES [F]', '#f59e0b');
    const qmSign = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.62, 0.38, 0.05)), qmSignMat);
    qmSign.position.set(-16.46, 2.48, -8.85);
    qmSign.rotation.y = Math.PI * 0.5;
    this.group.add(qmSign);

    const qmProxy = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.1, 1.2, 2.2)), proxyMat);
    qmProxy.position.set(-15.35, 1.12, -8.85);
    qmProxy.userData.hideoutInteractable = {
      kind: 'perimeter_quartermaster',
      maxDistanceM: 3.0,
    } satisfies HideoutInteractableMeta;
    this.group.add(qmProxy);
    interactableMeshes.push(qmProxy);

    // =========================================================================
    // 4. CONTRACT OFFICER SECTOR DISPATCH DESK (EAST WALL X = -7.45, Z = -9.15)
    // =========================================================================
    addBox(-7.45, 0.45, -9.15, 0.88, 0.9, 2.1, materials.darkSteel, 'metal', true);
    addBox(-7.45, 0.92, -9.15, 0.94, 0.05, 2.16, materials.brushedSteel, 'metal', false);
    const dispatchSignMat = materials.createSignMaterial(
      'CONTRACT DISPATCH',
      'SHARD BRIEFING · ROSTER [F]',
      '#10b981',
    );
    const dispatchSign = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.62, 0.38, 0.05)), dispatchSignMat);
    dispatchSign.position.set(-6.54, 2.48, -9.15);
    dispatchSign.rotation.y = -Math.PI * 0.5;
    this.group.add(dispatchSign);

    // =========================================================================
    // 5. REINFORCED HELIPAD ACCESS HATCH (EAST-NORTH BULKHEAD X = -6.52, Z = -12.1)
    // =========================================================================
    addBox(-6.56, 1.38, -12.1, 0.16, 2.48, 1.72, materials.darkSteel, 'metal', true);
    addBox(-6.62, 1.38, -12.1, 0.08, 2.16, 1.32, materials.brushedSteel, 'metal', false);

    // Hazard stripe threshold on floor in front of Helipad Hatch
    const heliStripe = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(0.42, 1.75)),
      materials.hazardStripe,
    );
    heliStripe.rotation.x = -Math.PI * 0.5;
    heliStripe.position.set(-6.98, 0.015, -12.1);
    this.group.add(heliStripe);

    // Illuminated Emerald Flight-Status Beacon
    this.heliBeaconMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xa7f3d0,
        emissive: new THREE.Color(0x10b981),
        emissiveIntensity: 2.2,
        roughness: 0.2,
      }),
    );
    const heliBeacon = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.1, 0.14, 0.38)),
      this.heliBeaconMat,
    );
    heliBeacon.position.set(-6.64, 2.74, -12.1);
    this.group.add(heliBeacon);

    const heliSignMat = materials.createSignMaterial(
      'HELIPAD PAD 01',
      'VALKYRIE 2-1 · PERIMETER LIFT [F]',
      '#10b981',
    );
    const heliSign = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(1.66, 0.42, 0.05)), heliSignMat);
    heliSign.position.set(-6.56, 3.12, -12.1);
    heliSign.rotation.y = -Math.PI * 0.5;
    this.group.add(heliSign);

    const heliProxy = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.8, 2.2, 1.65)), proxyMat);
    heliProxy.position.set(-6.9, 1.32, -12.1);
    heliProxy.userData.hideoutInteractable = {
      kind: 'perimeter_heli_hatch',
      maxDistanceM: 3.0,
    } satisfies HideoutInteractableMeta;
    this.group.add(heliProxy);
    interactableMeshes.push(heliProxy);
  }

  public syncRosterPlaques(roster: CharacterRosterState): void {
    for (let i = 0; i < this.plaques.length; i++) {
      const p = this.plaques[i];
      const ch = roster.slots[p.slotId];
      const isActive = roster.activeSlotId === p.slotId;
      const ctx = p.ctx;
      const w = p.canvas.width;
      const h = p.canvas.height;

      ctx.fillStyle = '#0b1015';
      ctx.fillRect(0, 0, w, h);

      if (!ch) {
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.32)';
        ctx.lineWidth = 3;
        ctx.strokeRect(4, 4, w - 8, h - 8);
        ctx.fillStyle = '#64748b';
        ctx.font = '700 20px "IBM Plex Mono", monospace';
        ctx.fillText(`ALCOVE 0${i + 1} · VACANT SLOT`, 22, 46);
        ctx.fillStyle = '#cbd5e1';
        ctx.font = '600 22px "Oswald", sans-serif';
        ctx.fillText('PRESS [F] TO RECRUIT OPERATOR', 22, 98);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '500 15px "IBM Plex Mono", monospace';
        ctx.fillText('PVE OR PVP HARDCORE SHARD', 22, 134);
        p.stripMat.emissive.setHex(0x475569);
        p.stripMat.emissiveIntensity = 0.65;
      } else {
        const fee = computeFieldHospitalFee(ch);
        const bankruptRisk = ch.cash < fee;
        const accent = bankruptRisk ? '#ef4444' : isActive ? '#10b981' : '#38bdf8';
        const faction = PMC_FACTIONS[ch.pmcFaction];

        ctx.fillStyle = isActive ? '#0d1f1a' : '#0f151d';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = accent;
        ctx.fillRect(0, 0, w, 10);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2.5;
        ctx.strokeRect(4, 4, w - 8, h - 8);

        ctx.fillStyle = accent;
        ctx.font = '700 18px "IBM Plex Mono", monospace';
        ctx.fillText(
          `SLOT 0${i + 1} · ${isActive ? 'ACTIVE POINT' : 'STANDBY'} · ${ch.shardMode}`,
          20,
          42,
        );

        ctx.fillStyle = '#f8fafc';
        ctx.font = '700 32px "Oswald", sans-serif';
        ctx.fillText(ch.callsign.toUpperCase().slice(0, 20), 20, 86);

        ctx.fillStyle = '#cbd5e1';
        ctx.font = '600 16px "IBM Plex Mono", monospace';
        ctx.fillText(
          `${faction.shortName} · $${ch.cash.toLocaleString()} · TIER ${ch.missions.progressionTier}`,
          20,
          118,
        );

        ctx.fillStyle = bankruptRisk ? '#fca5a5' : '#94a3b8';
        ctx.font = '600 14px "IBM Plex Mono", monospace';
        ctx.fillText(
          bankruptRisk
            ? `BANKRUPTCY RISK · MEDEVAC $${fee.toLocaleString()}`
            : `[F] SWITCH / DEPLOY · MEDEVAC $${fee.toLocaleString()}`,
          20,
          144,
        );

        p.stripMat.emissive.setHex(bankruptRisk ? 0xef4444 : isActive ? 0x10b981 : 0x38bdf8);
        p.stripMat.emissiveIntensity = isActive ? 2.1 : 1.1;
      }

      p.tex.needsUpdate = true;
    }
  }

  public getPropPos(kind: string, outPos: THREE.Vector3): boolean {
    if (kind === 'perimeter_heli_hatch') {
      outPos.copy(this.heliHatchPos);
      return true;
    }
    if (kind === 'perimeter_quartermaster') {
      outPos.copy(this.quartermasterPos);
      return true;
    }
    if (kind === 'perimeter_roster_alcove') {
      outPos.copy(this.dispatchDeskPos);
      return true;
    }
    return false;
  }

  public update(dt: number): void {
    this.animTime += dt;
    this.heliBeaconMat.emissiveIntensity = 1.65 + 0.65 * Math.sin(this.animTime * 3.4);
  }

  public dispose(): void {
    for (const g of this.ownedGeos) g.dispose();
    for (const m of this.ownedMats) m.dispose();
    for (const t of this.ownedTexs) t.dispose();
    this.group.parent?.remove(this.group);
  }
}

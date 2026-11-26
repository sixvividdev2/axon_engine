import * as THREE from 'three';
import type { BackpackTemplateId } from '../../src/modes/openworld/inventory/TetrisInventoryTypes';

export interface BuiltTacticalBackpackMesh {
  readonly templateId: BackpackTemplateId;
  readonly root: THREE.Group;
  readonly hitMeshes: THREE.Mesh[];
  dispose: () => void;
}

interface BackpackPalette {
  bodyHex: number;
  secondaryHex: number;
  webbingHex: number;
  buckleHex: number;
  frameHex: number;
  rollHex: number;
  patchHex: number;
}

const BACKPACK_PALETTES: Readonly<Record<BackpackTemplateId, BackpackPalette>> = {
  // Tier 1: Compact Ranger / OD Green Patrol Assault Pack
  pack_assault_20l: {
    bodyHex: 0x3f4b3b,
    secondaryHex: 0x333d30,
    webbingHex: 0x262d24,
    buckleHex: 0x1a1e1d,
    frameHex: 0x2b3033,
    rollHex: 0x485443,
    patchHex: 0x8f8360,
  },
  // Tier 2: Coyote Tan / Desert Earth Highland Field Rucksack
  pack_rucksack_35l: {
    bodyHex: 0x7e694d,
    secondaryHex: 0x67553d,
    webbingHex: 0x4b3e2d,
    buckleHex: 0x1d1b18,
    frameHex: 0x3a3733,
    rollHex: 0x555d47,
    patchHex: 0xb09257,
  },
  // Tier 3: Alpine Slate / Charcoal Heavy External-Frame Logistics Pack
  pack_logistics_55l: {
    bodyHex: 0x2f3740,
    secondaryHex: 0x242a32,
    webbingHex: 0x181c22,
    buckleHex: 0x14171a,
    frameHex: 0x7b8590,
    rollHex: 0x444b3e,
    patchHex: 0xd97706,
  },
};

function createCanvasCorduraBumpTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 64, 64);
  for (let y = 0; y < 64; y += 2) {
    for (let x = 0; x < 64; x += 2) {
      const weave = ((x + y) & 2) === 0 ? 148 : 108;
      ctx.fillStyle = `rgb(${weave},${weave},${weave})`;
      ctx.fillRect(x, y, 2, 2);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  tex.needsUpdate = true;
  return tex;
}

let _sharedCorduraBump: THREE.CanvasTexture | null | undefined;
function getSharedCorduraBump(): THREE.CanvasTexture | null {
  if (_sharedCorduraBump === undefined) {
    _sharedCorduraBump = createCanvasCorduraBumpTexture();
  }
  return _sharedCorduraBump;
}

/**
 * Procedurally constructs a multi-part PBR 3D tactical backpack mesh for one of the 3 tiers.
 *
 * Local coordinate convention:
 * - For `mode === 'worn'`: origin sits at the back-plate contact center of the operator's upper spine,
 *   with +Z pointing BACKWARD away from the operator's back (matching TacticalOperatorRig & CharacterSkeleton
 *   where -Z is forward and +Z is rear).
 * - For `mode === 'ground'`: origin sits at bottom-center (`y = 0`) so the pack rests flush on floors/terrain.
 */
export function buildTacticalBackpackMesh(
  templateId: BackpackTemplateId,
  options?: {
    mode?: 'worn' | 'ground';
    isFemale?: boolean;
    worldBackpackId?: string;
    castShadow?: boolean;
    receiveShadow?: boolean;
  },
): BuiltTacticalBackpackMesh {
  const mode = options?.mode ?? 'worn';
  const isFemale = Boolean(options?.isFemale);
  const castShadow = options?.castShadow ?? true;
  const receiveShadow = options?.receiveShadow ?? true;

  const palette = BACKPACK_PALETTES[templateId] ?? BACKPACK_PALETTES.pack_assault_20l;
  const bumpMap = getSharedCorduraBump();

  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const hitMeshes: THREE.Mesh[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geos.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    mats.push(m);
    return m;
  };

  const bodyMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: palette.bodyHex,
      roughness: 0.89,
      metalness: 0.04,
      bumpMap: bumpMap ?? undefined,
      bumpScale: bumpMap ? 0.004 : 0,
    }),
  );
  const secondaryMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: palette.secondaryHex,
      roughness: 0.92,
      metalness: 0.03,
      bumpMap: bumpMap ?? undefined,
      bumpScale: bumpMap ? 0.003 : 0,
    }),
  );
  const webbingMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: palette.webbingHex,
      roughness: 0.84,
      metalness: 0.06,
    }),
  );
  const buckleMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: palette.buckleHex,
      roughness: 0.38,
      metalness: 0.14,
    }),
  );
  const frameMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: palette.frameHex,
      roughness: 0.34,
      metalness: 0.72,
    }),
  );
  const rollMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: palette.rollHex,
      roughness: 0.94,
      metalness: 0.02,
    }),
  );
  const patchMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: palette.patchHex,
      roughness: 0.78,
      metalness: 0.06,
    }),
  );

  const root = new THREE.Group();
  root.name = `backpack_${templateId}_${mode}`;

  const packGroup = new THREE.Group();
  root.add(packGroup);

  const addPart = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    px: number,
    py: number,
    pz: number,
    rx = 0,
    ry = 0,
    rz = 0,
    isHitTarget = false,
  ): THREE.Mesh => {
    const m = new THREE.Mesh(trackGeo(geo), mat);
    m.position.set(px, py, pz);
    if (rx || ry || rz) m.rotation.set(rx, ry, rz);
    m.castShadow = castShadow;
    m.receiveShadow = receiveShadow;
    if (options?.worldBackpackId) {
      m.userData.worldBackpackId = options.worldBackpackId;
      m.userData.interactKind = 'ground_backpack';
    }
    if (isHitTarget) {
      hitMeshes.push(m);
    }
    packGroup.add(m);
    return m;
  };

  let packHeight = 0.40;
  let packDepth = 0.17;

  if (templateId === 'pack_assault_20l') {
    // Tier 1: Compact 20L Patrol Assault Pack
    packHeight = 0.39;
    packDepth = 0.16;
    const w = 0.27;

    // Main slim teardrop-tapered compartment
    addPart(new THREE.BoxGeometry(w, packHeight, packDepth), bodyMat, 0, 0, packDepth * 0.5, 0, 0, 0, true);
    // Angled upper hood crown
    addPart(new THREE.BoxGeometry(w * 0.92, 0.08, packDepth * 0.85), secondaryMat, 0, packHeight * 0.44, packDepth * 0.46, -0.18, 0, 0, true);
    // Front admin pocket (faces +Z rear)
    addPart(new THREE.BoxGeometry(w * 0.84, 0.21, 0.055), secondaryMat, 0, -0.05, packDepth + 0.025, 0, 0, 0, true);
    // 3 horizontal PALS/MOLLE webbing strips on front admin pocket
    for (let i = 0; i < 3; i++) {
      addPart(new THREE.BoxGeometry(w * 0.86, 0.018, 0.01), webbingMat, 0, -0.11 + i * 0.055, packDepth + 0.056);
    }
    // Velcro ID patch on upper rear face
    addPart(new THREE.BoxGeometry(0.11, 0.042, 0.008), patchMat, 0, 0.105, packDepth + 0.006);
    // Side compression straps + polymer fastex buckles
    for (const side of [-1, 1]) {
      addPart(new THREE.BoxGeometry(0.014, 0.024, packDepth + 0.04), webbingMat, side * (w * 0.5 + 0.006), 0.03, packDepth * 0.54);
      addPart(new THREE.BoxGeometry(0.018, 0.032, 0.028), buckleMat, side * (w * 0.5 + 0.008), 0.03, packDepth * 0.72);
    }
    // Top webbing carry/drag handle
    addPart(new THREE.BoxGeometry(0.11, 0.02, 0.022), webbingMat, 0, packHeight * 0.52 + 0.015, packDepth * 0.35);
    // Hydration tube port grommet
    addPart(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 8), buckleMat, 0.08, packHeight * 0.5, packDepth * 0.28);
  } else if (templateId === 'pack_rucksack_35l') {
    // Tier 2: Medium 35L Highland Field Rucksack
    packHeight = 0.48;
    packDepth = 0.21;
    const w = 0.32;

    // Main padded rucksack body
    addPart(new THREE.BoxGeometry(w, packHeight, packDepth), bodyMat, 0, 0, packDepth * 0.5, 0, 0, 0, true);
    // Overhanging buckled top storm lid
    addPart(new THREE.BoxGeometry(w * 1.04, 0.095, packDepth * 1.06), secondaryMat, 0, packHeight * 0.47, packDepth * 0.53, 0.08, 0, 0, true);
    // Twin side sustainment pouches
    for (const side of [-1, 1]) {
      addPart(new THREE.BoxGeometry(0.075, 0.26, 0.13), secondaryMat, side * (w * 0.5 + 0.036), -0.02, packDepth * 0.52, 0, 0, 0, true);
      // Pouch lid strap
      addPart(new THREE.BoxGeometry(0.08, 0.02, 0.026), webbingMat, side * (w * 0.5 + 0.038), 0.08, packDepth * 0.56);
    }
    // Twin vertical lid lash straps + fastex buckles down the rear face
    for (const side of [-1, 1]) {
      addPart(new THREE.BoxGeometry(0.026, packHeight * 0.88, 0.012), webbingMat, side * 0.082, 0.01, packDepth + 0.008);
      addPart(new THREE.BoxGeometry(0.032, 0.044, 0.022), buckleMat, side * 0.082, -0.09, packDepth + 0.014);
    }
    // Rear map/utility pocket
    addPart(new THREE.BoxGeometry(w * 0.72, 0.19, 0.05), secondaryMat, 0, -0.04, packDepth + 0.025, 0, 0, 0, true);
    // Lashed sleeping pad / bedroll cylinder underneath
    addPart(new THREE.CylinderGeometry(0.056, 0.056, w * 0.98, 12), rollMat, 0, -packHeight * 0.5 - 0.048, packDepth * 0.52, 0, 0, Math.PI * 0.5, true);
    // Unit patch on storm lid
    addPart(new THREE.BoxGeometry(0.11, 0.038, 0.008), patchMat, 0, packHeight * 0.48, packDepth + 0.022);
  } else {
    // Tier 3: Large 55L Heavy External-Frame Logistics Pack
    packHeight = 0.58;
    packDepth = 0.25;
    const w = 0.36;

    // External tubular aluminum load-bearing frame rails (left/right vertical + top/bottom crossbars)
    for (const side of [-1, 1]) {
      addPart(new THREE.CylinderGeometry(0.011, 0.011, packHeight + 0.08, 8), frameMat, side * (w * 0.5 + 0.012), 0.02, 0.024);
    }
    addPart(new THREE.CylinderGeometry(0.011, 0.011, w + 0.03, 8), frameMat, 0, packHeight * 0.5 + 0.05, 0.024, 0, 0, Math.PI * 0.5);
    addPart(new THREE.CylinderGeometry(0.011, 0.011, w + 0.03, 8), frameMat, 0, -packHeight * 0.5 - 0.01, 0.024, 0, 0, Math.PI * 0.5);

    // Tall heavy main haul compartment
    addPart(new THREE.BoxGeometry(w, packHeight, packDepth), bodyMat, 0, 0.01, packDepth * 0.5 + 0.02, 0, 0, 0, true);
    // Upper radio / medical lid compartment
    addPart(new THREE.BoxGeometry(w * 1.04, 0.12, packDepth * 1.05), secondaryMat, 0, packHeight * 0.5 + 0.035, packDepth * 0.52 + 0.02, 0.06, 0, 0, true);
    // Short flexible comms whip stub on upper-left lid
    addPart(new THREE.CylinderGeometry(0.004, 0.007, 0.22, 6), buckleMat, -w * 0.36, packHeight * 0.5 + 0.18, packDepth * 0.42, 0.08, 0, 0.12);
    // Large dual side sustainment pockets
    for (const side of [-1, 1]) {
      addPart(new THREE.BoxGeometry(0.09, 0.34, 0.16), secondaryMat, side * (w * 0.5 + 0.044), -0.02, packDepth * 0.52 + 0.02, 0, 0, 0, true);
      // Horizontal cinch straps
      addPart(new THREE.BoxGeometry(0.095, 0.022, 0.17), webbingMat, side * (w * 0.5 + 0.044), 0.06, packDepth * 0.52 + 0.02);
      addPart(new THREE.BoxGeometry(0.095, 0.022, 0.17), webbingMat, side * (w * 0.5 + 0.044), -0.10, packDepth * 0.52 + 0.02);
    }
    // Rear logistics beaver-tail panel + 3 horizontal webbing bands + twin heavy buckles
    addPart(new THREE.BoxGeometry(w * 0.78, 0.32, 0.065), secondaryMat, 0, -0.06, packDepth + 0.05, 0, 0, 0, true);
    for (let i = 0; i < 3; i++) {
      addPart(new THREE.BoxGeometry(w * 0.80, 0.02, 0.012), webbingMat, 0, -0.16 + i * 0.09, packDepth + 0.086);
    }
    for (const side of [-1, 1]) {
      addPart(new THREE.BoxGeometry(0.036, 0.048, 0.024), buckleMat, side * 0.10, 0.14, packDepth + 0.046);
    }
    // Lower bivouac roll cylinder
    addPart(new THREE.CylinderGeometry(0.068, 0.068, w * 1.04, 12), rollMat, 0, -packHeight * 0.5 - 0.055, packDepth * 0.5 + 0.02, 0, 0, Math.PI * 0.5, true);
    // High-visibility expedition logistics tab
    addPart(new THREE.BoxGeometry(0.12, 0.04, 0.01), patchMat, 0, packHeight * 0.5 + 0.04, packDepth + 0.042);
  }

  // Contoured shoulder harness straps (visible when worn or resting on the ground)
  const strapOffsetX = templateId === 'pack_assault_20l' ? 0.10 : templateId === 'pack_rucksack_35l' ? 0.115 : 0.128;
  for (const side of [-1, 1]) {
    addPart(
      new THREE.BoxGeometry(0.046, packHeight * 0.72, 0.02),
      webbingMat,
      side * strapOffsetX,
      0.03,
      -0.012,
      0,
      0,
      side * 0.05,
    );
  }

  if (mode === 'worn') {
    const scale = isFemale ? 0.88 : 1.0;
    packGroup.scale.setScalar(scale);
    // Keep top of pack below helmet nape while resting flush against back ballistic plate
    const yLift = templateId === 'pack_logistics_55l' ? 0.04 : templateId === 'pack_rucksack_35l' ? 0.02 : 0.0;
    packGroup.position.set(0, yLift, 0.012);
  } else {
    // Ground resting pose: bottom-center at y = 0, slight natural backward lean
    const bottomExtra =
      templateId === 'pack_logistics_55l'
        ? 0.125
        : templateId === 'pack_rucksack_35l'
          ? 0.105
          : 0.01;
    packGroup.position.set(0, packHeight * 0.5 + bottomExtra, -packDepth * 0.5);
    packGroup.rotation.x = -0.14;
  }

  return {
    templateId,
    root,
    hitMeshes,
    dispose: () => {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}

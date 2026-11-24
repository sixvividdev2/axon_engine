import * as THREE from 'three';

export interface HideoutMaterialLibrary {
  concreteWall: THREE.MeshStandardMaterial;
  concreteFloor: THREE.MeshStandardMaterial;
  concreteCeiling: THREE.MeshStandardMaterial;
  darkSteel: THREE.MeshStandardMaterial;
  brushedSteel: THREE.MeshStandardMaterial;
  cavityBlack: THREE.MeshStandardMaterial;
  pegboardWall: THREE.MeshStandardMaterial;
  lockerSteel: THREE.MeshStandardMaterial;
  lockerInterior: THREE.MeshStandardMaterial;
  tableWood: THREE.MeshStandardMaterial;
  rubberMat: THREE.MeshStandardMaterial;
  ammoCrateBody: THREE.MeshStandardMaterial;
  ammoCrateTop: THREE.MeshStandardMaterial;
  brassCasing: THREE.MeshStandardMaterial;
  steelCasing: THREE.MeshStandardMaterial;
  missionPaper: THREE.MeshStandardMaterial;
  warmLampEmissive: THREE.MeshStandardMaterial;
  hazardRedEmissive: THREE.MeshStandardMaterial;
  hazardStripe: THREE.MeshStandardMaterial;
  createSignMaterial: (title: string, subtitle: string, accentHex?: string) => THREE.MeshStandardMaterial;
  dispose: () => void;
}

function seededRand(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

function buildConcreteTextures(maxAniso: number, seed: number, isFloor: boolean): {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
} {
  const rand = seededRand(seed);
  const [albedoC, aCtx] = makeCanvas(512, 512);
  const [roughC, rCtx] = makeCanvas(512, 512);

  aCtx.fillStyle = isFloor ? '#35383a' : '#4a4e50';
  aCtx.fillRect(0, 0, 512, 512);
  rCtx.fillStyle = isFloor ? '#c8c8c8' : '#dcdcdc';
  rCtx.fillRect(0, 0, 512, 512);

  // Subtle Cold-War concrete mottling & damp mineral aggregate
  for (let i = 0; i < 420; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const rad = 10 + rand() * 44;
    const v = Math.floor((isFloor ? 44 : 62) + (rand() - 0.5) * 26);
    const alpha = 0.06 + rand() * 0.1;
    aCtx.fillStyle = `rgba(${v},${v + 2},${v + 1},${alpha})`;
    aCtx.beginPath();
    aCtx.arc(x, y, rad, 0, Math.PI * 2);
    aCtx.fill();

    const rv = Math.floor(175 + (rand() - 0.5) * 65);
    rCtx.fillStyle = `rgba(${rv},${rv},${rv},${alpha * 1.4})`;
    rCtx.beginPath();
    rCtx.arc(x, y, rad, 0, Math.PI * 2);
    rCtx.fill();
  }

  // Shuttered formwork seams (walls) or expansion slabs (floors)
  aCtx.strokeStyle = 'rgba(18, 20, 22, 0.34)';
  aCtx.lineWidth = isFloor ? 3 : 2;
  rCtx.strokeStyle = 'rgba(240, 240, 240, 0.5)';
  rCtx.lineWidth = isFloor ? 3 : 2;

  const step = isFloor ? 256 : 128;
  for (let y = 0; y <= 512; y += step) {
    aCtx.beginPath();
    aCtx.moveTo(0, y);
    aCtx.lineTo(512, y);
    aCtx.stroke();
    rCtx.beginPath();
    rCtx.moveTo(0, y);
    rCtx.lineTo(512, y);
    rCtx.stroke();
  }
  for (let x = 0; x <= 512; x += 256) {
    aCtx.beginPath();
    aCtx.moveTo(x, 0);
    aCtx.lineTo(x, 512);
    aCtx.stroke();
  }

  // Formwork tie-rod holes & damp vertical drips on walls
  if (!isFloor) {
    for (let row = 64; row < 512; row += 128) {
      for (let col = 64; col < 512; col += 128) {
        aCtx.fillStyle = 'rgba(14, 16, 17, 0.65)';
        aCtx.beginPath();
        aCtx.arc(col, row, 4, 0, Math.PI * 2);
        aCtx.fill();

        const drip = aCtx.createLinearGradient(col, row, col, row + 46);
        drip.addColorStop(0, 'rgba(22, 24, 24, 0.25)');
        drip.addColorStop(1, 'rgba(22, 24, 24, 0)');
        aCtx.fillStyle = drip;
        aCtx.fillRect(col - 3, row + 2, 6, 46);
      }
    }
  } else {
    // Subtle oil sheen patches on bunker floor
    for (let i = 0; i < 14; i++) {
      const ox = rand() * 512;
      const oy = rand() * 512;
      const orad = 18 + rand() * 38;
      aCtx.fillStyle = 'rgba(22, 23, 24, 0.14)';
      aCtx.beginPath();
      aCtx.arc(ox, oy, orad, 0, Math.PI * 2);
      aCtx.fill();
      rCtx.fillStyle = 'rgba(95, 95, 95, 0.28)';
      rCtx.beginPath();
      rCtx.arc(ox, oy, orad, 0, Math.PI * 2);
      rCtx.fill();
    }
  }

  // Fine mineral grain
  for (let i = 0; i < 2400; i++) {
    const gx = rand() * 512;
    const gy = rand() * 512;
    const g = Math.floor(30 + rand() * 80);
    aCtx.fillStyle = `rgba(${g},${g},${g},0.12)`;
    aCtx.fillRect(gx, gy, 2, 2);
  }

  const map = new THREE.CanvasTexture(albedoC);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = maxAniso;

  const roughnessMap = new THREE.CanvasTexture(roughC);
  roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;
  roughnessMap.anisotropy = maxAniso;

  return { map, roughnessMap };
}

function buildPegboardTexture(maxAniso: number): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(512, 512);
  ctx.fillStyle = '#181b1e';
  ctx.fillRect(0, 0, 512, 512);

  // Horizontal louvered tactical steel channels
  for (let y = 0; y < 512; y += 32) {
    ctx.fillStyle = '#202428';
    ctx.fillRect(0, y, 512, 22);
    ctx.fillStyle = '#08080a';
    ctx.fillRect(0, y + 22, 512, 6);
    ctx.fillStyle = '#2c3238';
    ctx.fillRect(0, y + 28, 512, 2);

    // Vertical mounting slots along each slat
    ctx.fillStyle = '#08080a';
    for (let x = 16; x < 512; x += 32) {
      ctx.fillRect(x, y + 6, 8, 10);
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 2);
  tex.anisotropy = maxAniso;
  return tex;
}

function buildWoodTexture(maxAniso: number): THREE.CanvasTexture {
  const rand = seededRand(812);
  const [c, ctx] = makeCanvas(512, 256);
  ctx.fillStyle = '#4c3624';
  ctx.fillRect(0, 0, 512, 256);

  for (let y = 0; y < 256; y += 3) {
    const shade = 58 + Math.floor((rand() - 0.5) * 26);
    ctx.fillStyle = `rgba(${shade + 18}, ${shade}, ${Math.max(12, shade - 18)}, 0.35)`;
    ctx.fillRect(0, y, 512, 2 + rand() * 2);
  }
  // Plank seams
  ctx.fillStyle = 'rgba(18, 12, 8, 0.55)';
  for (let y = 64; y < 256; y += 64) {
    ctx.fillRect(0, y, 512, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = maxAniso;
  return tex;
}

function buildAmmoCrateTexture(maxAniso: number, isTop: boolean): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(512, 256);
  ctx.fillStyle = '#333b2a';
  ctx.fillRect(0, 0, 512, 256);

  // Weathered painted olive metal/wood grain
  const rand = seededRand(isTop ? 901 : 902);
  for (let i = 0; i < 900; i++) {
    const v = Math.floor(38 + rand() * 34);
    ctx.fillStyle = `rgba(${v},${v + 8},${Math.max(12, v - 8)},0.16)`;
    ctx.fillRect(rand() * 512, rand() * 256, 4 + rand() * 16, 2);
  }

  // Steel edge frame
  ctx.strokeStyle = '#1f241c';
  ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, 498, 242);

  // Stenciled yellow-ochre military markings
  ctx.fillStyle = '#d4b45c';
  ctx.font = 'bold 34px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(isTop ? 'AMMUNITION RESUPPLY' : '7.62 / 5.56 / 12GA', 256, 114);
  ctx.font = '600 20px "IBM Plex Mono", monospace';
  ctx.fillStyle = 'rgba(212, 180, 92, 0.85)';
  ctx.fillText(isTop ? 'LOT 44-B · SMALL ARMS' : 'ORDNANCE · HANDLE WITH CARE', 256, 156);

  // Hazard corner ticks
  ctx.fillStyle = '#d4b45c';
  ctx.fillRect(28, 28, 42, 6);
  ctx.fillRect(442, 28, 42, 6);
  ctx.fillRect(28, 222, 42, 6);
  ctx.fillRect(442, 222, 42, 6);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

function buildMissionPaperTexture(maxAniso: number): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(512, 512);
  ctx.fillStyle = '#cfc7b4';
  ctx.fillRect(0, 0, 512, 512);

  // Subtle paper aging
  ctx.strokeStyle = 'rgba(72, 66, 56, 0.18)';
  ctx.lineWidth = 1;
  for (let i = 32; i < 512; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 20);
    ctx.lineTo(i, 492);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(20, i);
    ctx.lineTo(492, i);
    ctx.stroke();
  }

  // Topographic contour rings
  ctx.strokeStyle = 'rgba(92, 74, 52, 0.45)';
  ctx.lineWidth = 2;
  for (let r = 36; r <= 180; r += 26) {
    ctx.beginPath();
    ctx.ellipse(240, 260, r * 1.15, r * 0.78, 0.25, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Tactical sector marks (amber/red)
  ctx.strokeStyle = '#991b1b';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(285, 230, 34, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(140, 360);
  ctx.lineTo(260, 255);
  ctx.stroke();

  ctx.fillStyle = '#1f2326';
  ctx.font = 'bold 20px "IBM Plex Mono", monospace';
  ctx.fillText('SECTOR GRID 04-B', 32, 54);
  ctx.font = '14px "IBM Plex Mono", monospace';
  ctx.fillText('ZERO: 100M  ·  WIND: 0.0 M/S', 32, 78);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

function buildHazardStripeTexture(maxAniso: number): THREE.CanvasTexture {
  const [c, ctx] = makeCanvas(256, 64);
  ctx.fillStyle = '#18181a';
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = '#b45309';
  for (let x = -64; x < 320; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 22, 0);
    ctx.lineTo(x - 6, 64);
    ctx.lineTo(x - 28, 64);
    ctx.closePath();
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 1);
  tex.anisotropy = maxAniso;
  return tex;
}

export function createHideoutMaterials(maxAniso: number): HideoutMaterialLibrary {
  const textures: THREE.Texture[] = [];
  const materials: THREE.Material[] = [];

  const trackTex = <T extends THREE.Texture>(t: T): T => {
    textures.push(t);
    return t;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    materials.push(m);
    return m;
  };

  const wallConcrete = buildConcreteTextures(maxAniso, 101, false);
  trackTex(wallConcrete.map).repeat.set(2, 1);
  trackTex(wallConcrete.roughnessMap).repeat.set(2, 1);

  const floorConcrete = buildConcreteTextures(maxAniso, 202, true);
  trackTex(floorConcrete.map).repeat.set(8, 8);
  trackTex(floorConcrete.roughnessMap).repeat.set(8, 8);

  const pegTex = trackTex(buildPegboardTexture(maxAniso));
  const woodTex = trackTex(buildWoodTexture(maxAniso));
  const crateSideTex = trackTex(buildAmmoCrateTexture(maxAniso, false));
  const crateTopTex = trackTex(buildAmmoCrateTexture(maxAniso, true));
  const paperTex = trackTex(buildMissionPaperTexture(maxAniso));
  const hazardTex = trackTex(buildHazardStripeTexture(maxAniso));

  const concreteWall = trackMat(
    new THREE.MeshStandardMaterial({
      map: wallConcrete.map,
      roughnessMap: wallConcrete.roughnessMap,
      roughness: 0.88,
      metalness: 0.04,
    }),
  );

  const concreteFloor = trackMat(
    new THREE.MeshStandardMaterial({
      map: floorConcrete.map,
      roughnessMap: floorConcrete.roughnessMap,
      roughness: 0.82,
      metalness: 0.08,
    }),
  );

  const concreteCeiling = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x26292c,
      roughness: 0.94,
      metalness: 0.04,
    }),
  );

  const darkSteel = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1e2226,
      roughness: 0.44,
      metalness: 0.78,
    }),
  );

  const brushedSteel = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x5c646c,
      roughness: 0.3,
      metalness: 0.88,
    }),
  );

  const cavityBlack = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x08080a,
      roughness: 0.92,
      metalness: 0.1,
    }),
  );

  const pegboardWall = trackMat(
    new THREE.MeshStandardMaterial({
      map: pegTex,
      roughness: 0.52,
      metalness: 0.65,
    }),
  );

  const lockerSteel = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x353c38,
      roughness: 0.48,
      metalness: 0.62,
    }),
  );

  const lockerInterior = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x181c1a,
      roughness: 0.72,
      metalness: 0.4,
    }),
  );

  const tableWood = trackMat(
    new THREE.MeshStandardMaterial({
      map: woodTex,
      roughness: 0.66,
      metalness: 0.05,
    }),
  );

  const rubberMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x141719,
      roughness: 0.86,
      metalness: 0.04,
    }),
  );

  const ammoCrateBody = trackMat(
    new THREE.MeshStandardMaterial({
      map: crateSideTex,
      roughness: 0.72,
      metalness: 0.25,
    }),
  );

  const ammoCrateTop = trackMat(
    new THREE.MeshStandardMaterial({
      map: crateTopTex,
      roughness: 0.7,
      metalness: 0.28,
    }),
  );

  const brassCasing = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xc89b3c,
      roughness: 0.26,
      metalness: 0.92,
    }),
  );

  const steelCasing = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x525b55,
      roughness: 0.42,
      metalness: 0.82,
    }),
  );

  const missionPaper = trackMat(
    new THREE.MeshStandardMaterial({
      map: paperTex,
      roughness: 0.92,
      metalness: 0.0,
      side: THREE.DoubleSide,
    }),
  );

  const warmLampEmissive = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffdeb0,
      emissive: 0xffb347,
      emissiveIntensity: 2.2,
      roughness: 0.2,
    }),
  );

  const hazardRedEmissive = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xff7b6b,
      emissive: 0xdc2626,
      emissiveIntensity: 2.0,
      roughness: 0.25,
    }),
  );

  const hazardStripe = trackMat(
    new THREE.MeshStandardMaterial({
      map: hazardTex,
      roughness: 0.68,
      metalness: 0.12,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    }),
  );

  const createSignMaterial = (
    title: string,
    subtitle: string,
    accentHex = '#d97706',
  ): THREE.MeshStandardMaterial => {
    const [c, ctx] = makeCanvas(512, 144);
    ctx.fillStyle = '#14171a';
    ctx.fillRect(0, 0, 512, 144);
    ctx.strokeStyle = '#363c42';
    ctx.lineWidth = 6;
    ctx.strokeRect(4, 4, 504, 136);

    ctx.fillStyle = accentHex;
    ctx.fillRect(18, 22, 10, 100);

    ctx.fillStyle = '#e5e7eb';
    ctx.font = '700 42px "Oswald", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(title, 44, 72);

    ctx.fillStyle = '#9ca3af';
    ctx.font = '500 22px "IBM Plex Mono", monospace';
    ctx.fillText(subtitle, 44, 112);

    const tex = trackTex(new THREE.CanvasTexture(c));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso;

    return trackMat(
      new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.56,
        metalness: 0.32,
      }),
    );
  };

  return {
    concreteWall,
    concreteFloor,
    concreteCeiling,
    darkSteel,
    brushedSteel,
    cavityBlack,
    pegboardWall,
    lockerSteel,
    lockerInterior,
    tableWood,
    rubberMat,
    ammoCrateBody,
    ammoCrateTop,
    brassCasing,
    steelCasing,
    missionPaper,
    warmLampEmissive,
    hazardRedEmissive,
    hazardStripe,
    createSignMaterial,
    dispose: () => {
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
    },
  };
}

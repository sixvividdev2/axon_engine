import * as THREE from 'three';

export interface GymTextureSet {
  concreteAlbedo: THREE.CanvasTexture;
  concreteRoughness: THREE.CanvasTexture;
  concreteDarkAlbedo: THREE.CanvasTexture;
  woodAlbedo: THREE.CanvasTexture;
  woodRoughness: THREE.CanvasTexture;
  metalGrateAlbedo: THREE.CanvasTexture;
  metalGrateRoughness: THREE.CanvasTexture;
  gravelAlbedo: THREE.CanvasTexture;
  puddleAlbedo: THREE.CanvasTexture;
  puddleRoughness: THREE.CanvasTexture;
  hazardAlbedo: THREE.CanvasTexture;
  steelTargetAlbedo: THREE.CanvasTexture;
  paperTargetAlbedo: THREE.CanvasTexture;
  dispose: () => void;
}

function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function finalizeTexture(
  canvas: HTMLCanvasElement,
  isColor: boolean,
  repeatX: number,
  repeatY: number,
  maxAnisotropy: number,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = Math.min(8, Math.max(1, maxAnisotropy));
  tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Creates a crisp stenciled industrial signage CanvasTexture for zone plaques */
export function createStencilSignTexture(
  title: string,
  subtitle: string,
  accentHex = '#d4a64a',
  bgHex = '#232629',
  maxAnisotropy = 4,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 192;
  const ctx = canvas.getContext('2d')!;

  // Base painted steel/concrete backing
  ctx.fillStyle = bgHex;
  ctx.fillRect(0, 0, 512, 192);

  // Subtle grime speckles
  const rand = seededRandom(title.length * 9973 + subtitle.length * 31);
  for (let i = 0; i < 650; i++) {
    const x = rand() * 512;
    const y = rand() * 192;
    const a = 0.03 + rand() * 0.06;
    ctx.fillStyle = rand() > 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    ctx.fillRect(x, y, 2 + rand() * 4, 1 + rand() * 3);
  }

  // Top industrial accent bar
  ctx.fillStyle = accentHex;
  ctx.fillRect(0, 0, 512, 14);
  ctx.fillRect(0, 178, 512, 14);

  // Corner mounting bolts
  ctx.fillStyle = '#555b60';
  for (const [bx, by] of [
    [22, 32],
    [490, 32],
    [22, 160],
    [490, 160],
  ]) {
    ctx.beginPath();
    ctx.arc(bx, by, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Stencil title
  ctx.fillStyle = '#ecebe6';
  ctx.font = '700 44px "Oswald", "Impact", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title.toUpperCase(), 256, 84);

  // Subtitle
  ctx.fillStyle = accentHex;
  ctx.font = '600 22px "IBM Plex Mono", monospace';
  ctx.fillText(subtitle.toUpperCase(), 256, 138);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, Math.max(1, maxAnisotropy));
  tex.needsUpdate = true;
  return tex;
}

export function createGymTextures(maxAnisotropy: number): GymTextureSet {
  const tracked: THREE.CanvasTexture[] = [];
  const track = (t: THREE.CanvasTexture) => {
    tracked.push(t);
    return t;
  };

  // 1. Brutalist Board-Formed Concrete (albedo + roughness)
  const concCanvas = document.createElement('canvas');
  concCanvas.width = 512;
  concCanvas.height = 512;
  const cCtx = concCanvas.getContext('2d')!;
  const cRoughCanvas = document.createElement('canvas');
  cRoughCanvas.width = 512;
  cRoughCanvas.height = 512;
  const crCtx = cRoughCanvas.getContext('2d')!;

  cCtx.fillStyle = '#8d908e';
  cCtx.fillRect(0, 0, 512, 512);
  crCtx.fillStyle = '#c8c8c8';
  crCtx.fillRect(0, 0, 512, 512);

  const r1 = seededRandom(101);
  // Formwork seams
  for (let y = 0; y < 512; y += 128) {
    cCtx.fillStyle = 'rgba(42,45,44,0.34)';
    cCtx.fillRect(0, y, 512, 3);
    cCtx.fillStyle = 'rgba(215,218,215,0.16)';
    cCtx.fillRect(0, y + 3, 512, 2);
  }
  for (let x = 0; x < 512; x += 256) {
    cCtx.fillStyle = 'rgba(38,41,40,0.28)';
    cCtx.fillRect(x, 0, 3, 512);
  }
  // Tie-rod holes
  for (const ty of [64, 192, 320, 448]) {
    for (const tx of [64, 192, 320, 448]) {
      cCtx.fillStyle = 'rgba(30,32,32,0.52)';
      cCtx.beginPath();
      cCtx.arc(tx, ty, 4, 0, Math.PI * 2);
      cCtx.fill();
    }
  }
  // Mineral aggregate & weathered stains
  for (let i = 0; i < 4800; i++) {
    const x = r1() * 512;
    const y = r1() * 512;
    const sz = 1 + r1() * 5;
    const v = Math.floor(110 + r1() * 58);
    cCtx.fillStyle = `rgba(${v},${v + 2},${v},${0.16 + r1() * 0.14})`;
    cCtx.fillRect(x, y, sz, sz);

    const rv = Math.floor(165 + r1() * 75);
    crCtx.fillStyle = `rgba(${rv},${rv},${rv},0.22)`;
    crCtx.fillRect(x, y, sz * 1.4, sz * 1.4);
  }
  // Subtle rain streaks
  for (let i = 0; i < 42; i++) {
    const x = r1() * 512;
    const h = 40 + r1() * 200;
    const grad = cCtx.createLinearGradient(x, 0, x, h);
    grad.addColorStop(0, 'rgba(38,42,40,0.16)');
    grad.addColorStop(1, 'rgba(38,42,40,0)');
    cCtx.fillStyle = grad;
    cCtx.fillRect(x, r1() * 256, 3 + r1() * 8, h);
  }

  const concreteAlbedo = track(finalizeTexture(concCanvas, true, 1, 1, maxAnisotropy));
  const concreteRoughness = track(finalizeTexture(cRoughCanvas, false, 1, 1, maxAnisotropy));

  // 2. Dark Bunker Concrete (for darkroom interior & floor contrast)
  const darkCanvas = document.createElement('canvas');
  darkCanvas.width = 512;
  darkCanvas.height = 512;
  const dCtx = darkCanvas.getContext('2d')!;
  dCtx.drawImage(concCanvas, 0, 0);
  dCtx.fillStyle = 'rgba(18,20,22,0.72)';
  dCtx.fillRect(0, 0, 512, 512);
  const concreteDarkAlbedo = track(finalizeTexture(darkCanvas, true, 1, 1, maxAnisotropy));

  // 3. Wood Planks (albedo + roughness)
  const woodCanvas = document.createElement('canvas');
  woodCanvas.width = 512;
  woodCanvas.height = 512;
  const wCtx = woodCanvas.getContext('2d')!;
  const wRoughCanvas = document.createElement('canvas');
  wRoughCanvas.width = 512;
  wRoughCanvas.height = 512;
  const wrCtx = wRoughCanvas.getContext('2d')!;

  const r2 = seededRandom(202);
  const plankCount = 8;
  const plankW = 512 / plankCount;
  for (let p = 0; p < plankCount; p++) {
    const px = p * plankW;
    const baseR = 114 + Math.floor(r2() * 26);
    const baseG = 78 + Math.floor(r2() * 18);
    const baseB = 48 + Math.floor(r2() * 14);
    wCtx.fillStyle = `rgb(${baseR},${baseG},${baseB})`;
    wCtx.fillRect(px, 0, plankW, 512);

    const rv = 155 + Math.floor(r2() * 40);
    wrCtx.fillStyle = `rgb(${rv},${rv},${rv})`;
    wrCtx.fillRect(px, 0, plankW, 512);

    // Longitudinal grain fibers
    for (let g = 0; g < 65; g++) {
      const gx = px + r2() * plankW;
      wCtx.fillStyle = r2() > 0.5 ? 'rgba(42,24,12,0.16)' : 'rgba(170,130,85,0.12)';
      wCtx.fillRect(gx, 0, 1 + r2() * 2.5, 512);
    }
    // Plank seam
    wCtx.fillStyle = 'rgba(20,14,10,0.65)';
    wCtx.fillRect(px, 0, 2, 512);
    // Horizontal butt-joint
    const jy = Math.floor(r2() * 440) + 36;
    wCtx.fillRect(px, jy, plankW, 2);
  }
  const woodAlbedo = track(finalizeTexture(woodCanvas, true, 1, 2, maxAnisotropy));
  const woodRoughness = track(finalizeTexture(wRoughCanvas, false, 1, 2, maxAnisotropy));

  // 4. Industrial Metal Grating (albedo + roughness)
  const grateCanvas = document.createElement('canvas');
  grateCanvas.width = 512;
  grateCanvas.height = 512;
  const gCtx = grateCanvas.getContext('2d')!;
  const gRoughCanvas = document.createElement('canvas');
  gRoughCanvas.width = 512;
  gRoughCanvas.height = 512;
  const grCtx = gRoughCanvas.getContext('2d')!;

  gCtx.fillStyle = '#1b1f23';
  gCtx.fillRect(0, 0, 512, 512);
  grCtx.fillStyle = '#e5e5e5';
  grCtx.fillRect(0, 0, 512, 512);

  // Galvanized steel lattice ribs
  for (let y = 0; y < 512; y += 32) {
    gCtx.fillStyle = '#687179';
    gCtx.fillRect(0, y, 512, 9);
    gCtx.fillStyle = '#9aa3aa';
    gCtx.fillRect(0, y, 512, 2);
    grCtx.fillStyle = '#6c6c6c';
    grCtx.fillRect(0, y, 512, 9);
  }
  for (let x = 0; x < 512; x += 64) {
    gCtx.fillStyle = '#586068';
    gCtx.fillRect(x, 0, 7, 512);
    grCtx.fillStyle = '#606060';
    grCtx.fillRect(x, 0, 7, 512);
  }
  // Diamond tread pips
  gCtx.fillStyle = '#adb5bc';
  for (let y = 16; y < 512; y += 32) {
    for (let x = 16; x < 512; x += 32) {
      gCtx.fillRect(x - 3, y - 1, 6, 3);
    }
  }
  const metalGrateAlbedo = track(finalizeTexture(grateCanvas, true, 2, 4, maxAnisotropy));
  const metalGrateRoughness = track(finalizeTexture(gRoughCanvas, false, 2, 4, maxAnisotropy));

  // 5. Crushed Gravel Bed
  const gravCanvas = document.createElement('canvas');
  gravCanvas.width = 512;
  gravCanvas.height = 512;
  const gvCtx = gravCanvas.getContext('2d')!;
  gvCtx.fillStyle = '#5a5751';
  gvCtx.fillRect(0, 0, 512, 512);
  const r3 = seededRandom(303);
  for (let i = 0; i < 6500; i++) {
    const x = r3() * 512;
    const y = r3() * 512;
    const rx = 2 + r3() * 5;
    const ry = 1.5 + r3() * 4;
    const shade = Math.floor(62 + r3() * 98);
    const warm = Math.floor(r3() * 14);
    gvCtx.fillStyle = `rgb(${shade + warm},${shade + Math.floor(warm * 0.6)},${shade})`;
    gvCtx.beginPath();
    gvCtx.ellipse(x, y, rx, ry, r3() * Math.PI, 0, Math.PI * 2);
    gvCtx.fill();
  }
  const gravelAlbedo = track(finalizeTexture(gravCanvas, true, 2, 4, maxAnisotropy));

  // 6. Standing Water Puddle over Wet Dark Concrete
  const pudCanvas = document.createElement('canvas');
  pudCanvas.width = 512;
  pudCanvas.height = 512;
  const pCtx = pudCanvas.getContext('2d')!;
  const pRoughCanvas = document.createElement('canvas');
  pRoughCanvas.width = 512;
  pRoughCanvas.height = 512;
  const prCtx = pRoughCanvas.getContext('2d')!;

  pCtx.fillStyle = '#2d373d';
  pCtx.fillRect(0, 0, 512, 512);
  prCtx.fillStyle = '#141414'; // Mirror-like low roughness water
  prCtx.fillRect(0, 0, 512, 512);

  const r4 = seededRandom(404);
  for (let i = 0; i < 38; i++) {
    const x = r4() * 512;
    const y = r4() * 512;
    const rad = 18 + r4() * 54;
    const g = pCtx.createRadialGradient(x, y, 2, x, y, rad);
    g.addColorStop(0, 'rgba(92,118,128,0.14)');
    g.addColorStop(1, 'rgba(34,44,50,0)');
    pCtx.fillStyle = g;
    pCtx.beginPath();
    pCtx.arc(x, y, rad, 0, Math.PI * 2);
    pCtx.fill();
  }
  // Subtle dry concrete border edges
  prCtx.strokeStyle = '#9e9e9e';
  prCtx.lineWidth = 24;
  prCtx.strokeRect(0, 0, 512, 512);
  pCtx.strokeStyle = 'rgba(110,114,112,0.45)';
  pCtx.lineWidth = 18;
  pCtx.strokeRect(0, 0, 512, 512);

  const puddleAlbedo = track(finalizeTexture(pudCanvas, true, 1, 2, maxAnisotropy));
  const puddleRoughness = track(finalizeTexture(pRoughCanvas, false, 1, 2, maxAnisotropy));

  // 7. Industrial Yellow/Black Hazard Stripes
  const hazCanvas = document.createElement('canvas');
  hazCanvas.width = 256;
  hazCanvas.height = 256;
  const hCtx = hazCanvas.getContext('2d')!;
  hCtx.fillStyle = '#c89b2b';
  hCtx.fillRect(0, 0, 256, 256);
  hCtx.fillStyle = '#1b1d1e';
  for (let i = -256; i < 512; i += 64) {
    hCtx.beginPath();
    hCtx.moveTo(i, 0);
    hCtx.lineTo(i + 32, 0);
    hCtx.lineTo(i - 224, 256);
    hCtx.lineTo(i - 256, 256);
    hCtx.closePath();
    hCtx.fill();
  }
  // Subtle scuffing
  hCtx.fillStyle = 'rgba(255,255,255,0.06)';
  for (let i = 0; i < 240; i++) {
    hCtx.fillRect(r1() * 256, r1() * 256, 4, 2);
  }
  const hazardAlbedo = track(finalizeTexture(hazCanvas, true, 3, 1, maxAnisotropy));

  // 8. Reactive AR500 Steel Silhouette Target Texture
  const steelCanvas = document.createElement('canvas');
  steelCanvas.width = 256;
  steelCanvas.height = 384;
  const sCtx = steelCanvas.getContext('2d')!;
  sCtx.fillStyle = '#d8d4c8';
  sCtx.fillRect(0, 0, 256, 384);
  // Center A-zone orange box + past impact pockmarks
  sCtx.strokeStyle = '#c85a2a';
  sCtx.lineWidth = 6;
  sCtx.strokeRect(64, 96, 128, 168);
  sCtx.fillStyle = '#c85a2a';
  sCtx.beginPath();
  sCtx.arc(128, 152, 22, 0, Math.PI * 2);
  sCtx.fill();
  // Head box
  sCtx.strokeRect(86, 22, 84, 54);
  // Subtle metallic wear
  for (let i = 0; i < 36; i++) {
    sCtx.fillStyle = 'rgba(55,60,64,0.38)';
    sCtx.beginPath();
    sCtx.arc(60 + r2() * 136, 70 + r2() * 220, 2 + r2() * 4, 0, Math.PI * 2);
    sCtx.fill();
  }
  const steelTargetAlbedo = track(finalizeTexture(steelCanvas, true, 1, 1, maxAnisotropy));

  // 9. Paper Bullseye Target Texture
  const papCanvas = document.createElement('canvas');
  papCanvas.width = 512;
  papCanvas.height = 512;
  const ppCtx = papCanvas.getContext('2d')!;
  ppCtx.fillStyle = '#e5dec9';
  ppCtx.fillRect(0, 0, 512, 512);
  // Grid lines
  ppCtx.strokeStyle = 'rgba(60,55,48,0.18)';
  ppCtx.lineWidth = 1;
  for (let i = 32; i < 512; i += 32) {
    ppCtx.beginPath();
    ppCtx.moveTo(i, 0);
    ppCtx.lineTo(i, 512);
    ppCtx.stroke();
    ppCtx.beginPath();
    ppCtx.moveTo(0, i);
    ppCtx.lineTo(512, i);
    ppCtx.stroke();
  }
  // Concentric scoring rings
  const rings = [
    { r: 210, fill: null, stroke: '#2a2b2d', w: 3 },
    { r: 165, fill: null, stroke: '#2a2b2d', w: 3 },
    { r: 120, fill: '#252729', stroke: '#e5dec9', w: 2 },
    { r: 78, fill: '#252729', stroke: '#e5dec9', w: 2 },
    { r: 38, fill: '#c84b2a', stroke: '#e5dec9', w: 2 },
    { r: 12, fill: '#f2ece1', stroke: '#252729', w: 2 },
  ];
  for (const ring of rings) {
    ppCtx.beginPath();
    ppCtx.arc(256, 256, ring.r, 0, Math.PI * 2);
    if (ring.fill) {
      ppCtx.fillStyle = ring.fill;
      ppCtx.fill();
    }
    ppCtx.strokeStyle = ring.stroke;
    ppCtx.lineWidth = ring.w;
    ppCtx.stroke();
  }
  ppCtx.fillStyle = '#252729';
  ppCtx.font = '700 22px "IBM Plex Mono", monospace';
  ppCtx.textAlign = 'center';
  ppCtx.fillText('ZEROING TARGET // 1 MOA GRID', 256, 30);

  const paperTargetAlbedo = track(finalizeTexture(papCanvas, true, 1, 1, maxAnisotropy));

  return {
    concreteAlbedo,
    concreteRoughness,
    concreteDarkAlbedo,
    woodAlbedo,
    woodRoughness,
    metalGrateAlbedo,
    metalGrateRoughness,
    gravelAlbedo,
    puddleAlbedo,
    puddleRoughness,
    hazardAlbedo,
    steelTargetAlbedo,
    paperTargetAlbedo,
    dispose: () => {
      for (const t of tracked) t.dispose();
    },
  };
}

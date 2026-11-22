import * as THREE from 'three';

function seededRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeCanvasTex(
  canvas: HTMLCanvasElement,
  repeatX: number,
  repeatY: number,
  maxAniso: number,
  isColor = true,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = Math.min(8, Math.max(1, maxAniso));
  tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Grimy Soviet brutalist concrete with formwork seams and moisture stains */
export function createSovietConcreteTexture(
  maxAniso: number,
  repeatX = 2,
  repeatY = 2,
  tintHex = '#7c817e',
  seed = 404,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(seed);

  ctx.fillStyle = tintHex;
  ctx.fillRect(0, 0, 512, 512);

  // Formwork panel joints
  for (let y = 0; y < 512; y += 128) {
    ctx.fillStyle = 'rgba(22,25,24,0.38)';
    ctx.fillRect(0, y, 512, 4);
    ctx.fillStyle = 'rgba(220,225,220,0.12)';
    ctx.fillRect(0, y + 4, 512, 2);
  }
  for (let x = 0; x < 512; x += 256) {
    ctx.fillStyle = 'rgba(20,22,21,0.32)';
    ctx.fillRect(x, 0, 3, 512);
  }

  // Moisture & soot patches
  for (let i = 0; i < 65; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const r = 18 + rand() * 68;
    const grad = ctx.createRadialGradient(x, y, 2, x, y, r);
    const dark = rand() > 0.35;
    grad.addColorStop(0, dark ? 'rgba(24,26,23,0.16)' : 'rgba(210,214,208,0.10)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Fine aggregate speckle
  for (let i = 0; i < 2400; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const a = 0.04 + rand() * 0.09;
    ctx.fillStyle = rand() > 0.5 ? `rgba(18,20,19,${a})` : `rgba(225,228,224,${a * 0.7})`;
    ctx.fillRect(x, y, 2, 2);
  }

  // Bottom damp band
  const damp = ctx.createLinearGradient(0, 390, 0, 512);
  damp.addColorStop(0, 'rgba(20,22,18,0)');
  damp.addColorStop(1, 'rgba(18,20,16,0.34)');
  ctx.fillStyle = damp;
  ctx.fillRect(0, 390, 512, 122);

  return makeCanvasTex(c, repeatX, repeatY, maxAniso, true);
}

/** Peeling institutional Soviet corridor paint (pale institutional sage-teal lower band + cream plaster) */
export function createSovietPlasterTexture(maxAniso: number, repeatX = 2, repeatY = 1): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(812);

  // Upper faded ochre-gray plaster
  ctx.fillStyle = '#8b887c';
  ctx.fillRect(0, 0, 512, 268);

  // Lower institutional Soviet green-gray dado paint
  ctx.fillStyle = '#4e635a';
  ctx.fillRect(0, 268, 512, 244);

  // Dado trim line
  ctx.fillStyle = '#2d3a35';
  ctx.fillRect(0, 264, 512, 8);

  // Peeling patches & water streaks
  for (let i = 0; i < 90; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const w = 6 + rand() * 34;
    const h = 4 + rand() * 24;
    ctx.fillStyle = rand() > 0.45 ? 'rgba(65,64,58,0.22)' : 'rgba(28,30,27,0.18)';
    ctx.fillRect(x, y, w, h);
  }

  for (let i = 0; i < 24; i++) {
    const x = rand() * 512;
    ctx.fillStyle = 'rgba(22,25,21,0.14)';
    ctx.fillRect(x, 0, 2 + rand() * 5, 160 + rand() * 260);
  }

  return makeCanvasTex(c, repeatX, repeatY, maxAniso, true);
}

/** Overcast forest floor: pine needles, damp soil, moss patches */
export function createForestFloorTexture(maxAniso: number, repeatX = 18, repeatY = 18): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(515);

  ctx.fillStyle = '#38412f';
  ctx.fillRect(0, 0, 512, 512);

  // Organic soil & moss mottling
  for (let i = 0; i < 120; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const r = 14 + rand() * 54;
    const g = ctx.createRadialGradient(x, y, 2, x, y, r);
    const pick = rand();
    if (pick < 0.35) {
      g.addColorStop(0, 'rgba(62,51,37,0.34)'); // brown pine duff
    } else if (pick < 0.72) {
      g.addColorStop(0, 'rgba(46,66,38,0.30)'); // deep moss
    } else {
      g.addColorStop(0, 'rgba(34,39,28,0.28)'); // shadow loam
    }
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Scattered pine needles & twigs
  for (let i = 0; i < 2600; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const ang = rand() * Math.PI;
    const len = 3 + rand() * 8;
    ctx.strokeStyle = rand() > 0.5 ? 'rgba(92,76,52,0.45)' : 'rgba(54,74,42,0.42)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }

  return makeCanvasTex(c, repeatX, repeatY, maxAniso, true);
}

/** Rustic weathered timber planks for cabins and barricades */
export function createCabinWoodTexture(
  maxAniso: number,
  repeatX = 2,
  repeatY = 2,
  baseHex = '#5d4734',
  seed = 707,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(seed);

  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 512, 512);

  const plankH = 64;
  for (let row = 0; row < 8; row++) {
    const y = row * plankH;
    const shade = (rand() - 0.5) * 26;
    ctx.fillStyle = shade > 0 ? `rgba(255,235,205,${shade / 320})` : `rgba(18,12,8,${-shade / 240})`;
    ctx.fillRect(0, y, 512, plankH);

    // Grain streaks
    for (let g = 0; g < 18; g++) {
      ctx.fillStyle = rand() > 0.5 ? 'rgba(28,18,10,0.16)' : 'rgba(210,180,145,0.08)';
      ctx.fillRect(0, y + rand() * plankH, 512, 1 + rand() * 2);
    }

    // Plank seam
    ctx.fillStyle = 'rgba(18,12,8,0.65)';
    ctx.fillRect(0, y, 512, 3);
  }

  return makeCanvasTex(c, repeatX, repeatY, maxAniso, true);
}

/** Corrugated painted steel for shipping containers */
export function createCorrugatedMetalTexture(
  maxAniso: number,
  colorHex = '#4b5a63',
  seed = 909,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(seed);

  ctx.fillStyle = colorHex;
  ctx.fillRect(0, 0, 512, 512);

  // Vertical corrugation ribs
  for (let x = 0; x < 512; x += 32) {
    ctx.fillStyle = 'rgba(0,0,0,0.26)';
    ctx.fillRect(x, 0, 8, 512);
    ctx.fillStyle = 'rgba(255,255,255,0.11)';
    ctx.fillRect(x + 8, 0, 8, 512);
  }

  // Rust streaks
  for (let i = 0; i < 45; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    ctx.fillStyle = 'rgba(116,56,28,0.28)';
    ctx.fillRect(x, y, 8 + rand() * 22, 18 + rand() * 64);
  }

  return makeCanvasTex(c, 2, 1, maxAniso, true);
}

/** 1940s Grand Theater checkered aged marble foyer tile */
export function createTheaterTileTexture(maxAniso: number, repeatX = 6, repeatY = 6): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(1944);

  const step = 128;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const light = (row + col) % 2 === 0;
      ctx.fillStyle = light ? '#9a9182' : '#262426';
      ctx.fillRect(col * step, row * step, step, step);

      // Marble veining
      ctx.strokeStyle = light ? 'rgba(65,58,48,0.16)' : 'rgba(175,168,158,0.11)';
      ctx.lineWidth = 1.5;
      for (let v = 0; v < 4; v++) {
        ctx.beginPath();
        const sx = col * step + rand() * step;
        const sy = row * step + rand() * step;
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + (rand() - 0.5) * 90, sy + (rand() - 0.5) * 90);
        ctx.stroke();
      }
    }
  }

  // Grout lines & grime
  ctx.strokeStyle = 'rgba(15,12,12,0.55)';
  ctx.lineWidth = 3;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * step, 0);
    ctx.lineTo(i * step, 512);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * step);
    ctx.lineTo(512, i * step);
    ctx.stroke();
  }

  for (let i = 0; i < 65; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const r = 12 + rand() * 44;
    const g = ctx.createRadialGradient(x, y, 2, x, y, r);
    g.addColorStop(0, 'rgba(28,16,14,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  return makeCanvasTex(c, repeatX, repeatY, maxAniso, true);
}

/** Aged crimson-burgundy ornate theater wallpaper / acoustic paneling */
export function createTheaterWallTexture(maxAniso: number, repeatX = 3, repeatY = 1): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(1961);

  // Dark mahogany lower wainscot
  ctx.fillStyle = '#291c18';
  ctx.fillRect(0, 320, 512, 192);

  // Aged burgundy damask upper wall
  ctx.fillStyle = '#471f22';
  ctx.fillRect(0, 0, 512, 320);

  // Subtle vertical damask stripes
  for (let x = 0; x < 512; x += 32) {
    ctx.fillStyle = 'rgba(92,38,40,0.24)';
    ctx.fillRect(x, 0, 12, 320);
  }

  // Tarnished gold chair rail
  ctx.fillStyle = '#8b6d3c';
  ctx.fillRect(0, 314, 512, 10);

  // Decay, scorch & peeling plaster marks
  for (let i = 0; i < 85; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const r = 10 + rand() * 42;
    const g = ctx.createRadialGradient(x, y, 1, x, y, r);
    g.addColorStop(0, 'rgba(18,12,12,0.32)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  return makeCanvasTex(c, repeatX, repeatY, maxAniso, true);
}

/** Crisp chalk weapon wall-buy plaque texture for Infection mode */
export function createWallBuyTexture(
  weaponName: string,
  cost: number,
  maxAniso: number,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d')!;

  ctx.clearRect(0, 0, 512, 256);
  ctx.fillStyle = 'rgba(14,10,12,0.68)';
  ctx.fillRect(10, 10, 492, 236);

  ctx.strokeStyle = 'rgba(232,226,210,0.85)';
  ctx.lineWidth = 4;
  ctx.setLineDash([12, 6]);
  ctx.strokeRect(20, 20, 472, 216);
  ctx.setLineDash([]);

  // Stylized chalk rifle silhouette
  ctx.strokeStyle = '#efe9d8';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(80, 126);
  ctx.lineTo(155, 110);
  ctx.lineTo(360, 110);
  ctx.lineTo(435, 115);
  ctx.moveTo(190, 112);
  ctx.lineTo(182, 162);
  ctx.moveTo(260, 112);
  ctx.lineTo(272, 168);
  ctx.lineTo(294, 165);
  ctx.lineTo(286, 112);
  ctx.stroke();

  ctx.fillStyle = '#f5ecd4';
  ctx.font = '700 34px "Oswald", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(weaponName.toUpperCase(), 256, 72);

  ctx.fillStyle = '#e5c07b';
  ctx.font = '600 26px "IBM Plex Mono", monospace';
  ctx.fillText(`${cost} PTS  ·  AMMO ${Math.round(cost * 0.5)}`, 256, 212);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, Math.max(1, maxAniso));
  tex.needsUpdate = true;
  return tex;
}

/** Distressed theater cinema screen texture with tear & vintage dust */
export function createCinemaScreenTexture(maxAniso: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(1955);

  ctx.fillStyle = '#c8c1ad';
  ctx.fillRect(0, 0, 512, 256);

  // Aging vignette & water stains
  const g = ctx.createRadialGradient(256, 128, 30, 256, 128, 280);
  g.addColorStop(0, 'rgba(255,250,235,0.2)');
  g.addColorStop(1, 'rgba(32,26,20,0.58)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 256);

  // Diagonal dark rip across screen
  ctx.fillStyle = '#151213';
  ctx.beginPath();
  ctx.moveTo(310, 0);
  ctx.lineTo(342, 0);
  ctx.lineTo(295, 148);
  ctx.lineTo(275, 195);
  ctx.lineTo(266, 140);
  ctx.closePath();
  ctx.fill();

  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = 'rgba(55,44,34,0.16)';
    ctx.fillRect(rand() * 512, rand() * 256, 14 + rand() * 38, 12 + rand() * 44);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, Math.max(1, maxAniso));
  tex.needsUpdate = true;
  return tex;
}

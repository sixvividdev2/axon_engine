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

/** Pripyat Option 1: Peeling Soviet turquoise-teal lower dado + faded amber-ochre upper plaster */
export function createPripyatTealPlasterTexture(
  maxAniso: number,
  repeatX = 2,
  repeatY = 1,
  seed = 1986,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(seed);

  // Upper warm aged ochre-ivory plaster
  ctx.fillStyle = '#a39981';
  ctx.fillRect(0, 0, 512, 252);

  // Lower iconic Pripyat Soviet turquoise-teal institutional paint
  ctx.fillStyle = '#3c6e6b';
  ctx.fillRect(0, 252, 512, 260);

  // Dark teal & rust dado stripe
  ctx.fillStyle = '#244544';
  ctx.fillRect(0, 246, 512, 10);
  ctx.fillStyle = '#6f5235';
  ctx.fillRect(0, 256, 512, 3);

  // Flaking & peeling paint patches exposing gray raw concrete underneath
  for (let i = 0; i < 115; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const w = 8 + rand() * 44;
    const h = 6 + rand() * 32;
    const pick = rand();
    if (pick < 0.45) {
      ctx.fillStyle = 'rgba(116,114,106,0.48)'; // exposed raw plaster
    } else if (pick < 0.78) {
      ctx.fillStyle = 'rgba(132,84,42,0.22)'; // warm amber rust / damp bloom
    } else {
      ctx.fillStyle = 'rgba(22,30,28,0.28)'; // dark mold stain
    }
    ctx.fillRect(x, y, w, h);
  }

  // Vertical rain-leak & damp streaks from ceiling
  for (let i = 0; i < 32; i++) {
    const x = rand() * 512;
    const len = 100 + rand() * 340;
    const grad = ctx.createLinearGradient(0, 0, 0, len);
    grad.addColorStop(0, 'rgba(34,29,22,0.28)');
    grad.addColorStop(1, 'rgba(34,29,22,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, 0, 2 + rand() * 6, len);
  }

  // Crack lines
  ctx.strokeStyle = 'rgba(26,24,22,0.48)';
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 16; i++) {
    let cx = rand() * 512;
    let cy = rand() * 512;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (let s = 0; s < 5; s++) {
      cx += (rand() - 0.5) * 34;
      cy += 10 + rand() * 24;
      ctx.lineTo(cx, cy);
    }
    ctx.stroke();
  }

  return makeCanvasTex(c, repeatX, repeatY, maxAniso, true);
}

/** Weathered Soviet Brezhnevka precast exterior panel concrete with moss & rust runoff */
export function createPripyatPanelConcreteTexture(
  maxAniso: number,
  repeatX = 3,
  repeatY = 2,
  seed = 1989,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(seed);

  ctx.fillStyle = '#8b8d87';
  ctx.fillRect(0, 0, 512, 512);

  // Subtle tile-mosaic facade grid typical of Pripyat apartment blocks
  for (let y = 0; y < 512; y += 128) {
    for (let x = 0; x < 512; x += 128) {
      const shade = (rand() - 0.5) * 18;
      ctx.fillStyle = shade > 0 ? `rgba(235,232,220,${shade / 260})` : `rgba(30,34,32,${-shade / 240})`;
      ctx.fillRect(x + 4, y + 4, 120, 120);
    }
    ctx.fillStyle = 'rgba(24,26,24,0.48)';
    ctx.fillRect(0, y, 512, 5);
  }
  for (let x = 0; x < 512; x += 128) {
    ctx.fillStyle = 'rgba(24,26,24,0.42)';
    ctx.fillRect(x, 0, 4, 512);
  }

  // Amber-rust rebar bleed + green moss at seams
  for (let i = 0; i < 42; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const isMoss = rand() > 0.45;
    ctx.fillStyle = isMoss ? 'rgba(62,82,48,0.28)' : 'rgba(138,76,38,0.24)';
    ctx.fillRect(x, y, 6 + rand() * 24, 16 + rand() * 68);
  }

  // Fine mineral grain
  for (let i = 0; i < 2200; i++) {
    const a = 0.05 + rand() * 0.08;
    ctx.fillStyle = rand() > 0.5 ? `rgba(22,24,22,${a})` : `rgba(230,226,216,${a * 0.8})`;
    ctx.fillRect(rand() * 512, rand() * 512, 2, 2);
  }

  return makeCanvasTex(c, repeatX, repeatY, maxAniso, true);
}

/** Oxidized rusted metal sheet for abandoned Soviet vehicles & machinery */
export function createRustedMetalTexture(
  maxAniso: number,
  basePaintHex = '#4f6d6c',
  seed = 301,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(seed);

  ctx.fillStyle = basePaintHex;
  ctx.fillRect(0, 0, 256, 256);

  // Heavy rust bloom & blistering oxidation
  for (let i = 0; i < 85; i++) {
    const x = rand() * 256;
    const y = rand() * 256;
    const r = 6 + rand() * 36;
    const g = ctx.createRadialGradient(x, y, 1, x, y, r);
    const tone = rand();
    if (tone < 0.45) {
      g.addColorStop(0, 'rgba(128,58,24,0.72)');
    } else if (tone < 0.8) {
      g.addColorStop(0, 'rgba(92,40,18,0.65)');
    } else {
      g.addColorStop(0, 'rgba(164,86,36,0.52)');
    }
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Drip streaks & scratches
  for (let i = 0; i < 36; i++) {
    ctx.fillStyle = 'rgba(72,30,14,0.34)';
    ctx.fillRect(rand() * 256, rand() * 200, 1 + rand() * 3, 18 + rand() * 64);
  }

  return makeCanvasTex(c, 1, 1, maxAniso, true);
}

/** Cracked weathered asphalt with moss seams for courtyards & roads */
export function createAsphaltRoadTexture(
  maxAniso: number,
  repeatX = 12,
  repeatY = 12,
  mossy = true,
  seed = 616,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(seed);

  ctx.fillStyle = '#3b3e3f';
  ctx.fillRect(0, 0, 512, 512);

  // Aggregate mineral speckle
  for (let i = 0; i < 3600; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const bright = rand() > 0.55;
    ctx.fillStyle = bright ? 'rgba(135,140,138,0.14)' : 'rgba(16,18,19,0.22)';
    ctx.fillRect(x, y, 2, 2);
  }

  // Cracks & optional overgrown moss in fractures
  for (let i = 0; i < 18; i++) {
    let x = rand() * 512;
    let y = rand() * 512;
    ctx.strokeStyle = 'rgba(14,16,16,0.72)';
    ctx.lineWidth = 2.0;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 6; s++) {
      x += (rand() - 0.5) * 44;
      y += (rand() - 0.5) * 44;
      ctx.lineTo(x, y);
    }
    ctx.stroke();

    if (mossy && rand() > 0.35) {
      ctx.strokeStyle = 'rgba(68,94,48,0.42)';
      ctx.lineWidth = 4.2;
      ctx.stroke();
    }
  }

  return makeCanvasTex(c, repeatX, repeatY, maxAniso, true);
}

/** Kino Art-Deco Noir Wall: Deep emerald-jade geometric damask + walnut wainscot + tarnished brass rail (less red!) */
export function createKinoEmeraldWallTexture(
  maxAniso: number,
  repeatX = 3,
  repeatY = 1,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(1945);

  // Upper deep Art-Deco slate-emerald plaster
  ctx.fillStyle = '#1e3532';
  ctx.fillRect(0, 0, 512, 318);

  // Subtle Art-Deco fan & vertical pinstripe gold-jade motif
  ctx.strokeStyle = 'rgba(176,148,88,0.18)';
  ctx.lineWidth = 2;
  for (let x = 0; x < 512; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 318);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 32, 160, 26, Math.PI, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 32, 280, 26, Math.PI, 0);
    ctx.stroke();
  }

  // Lower dark walnut paneling
  ctx.fillStyle = '#241e19';
  ctx.fillRect(0, 326, 512, 186);
  for (let x = 16; x < 512; x += 128) {
    ctx.strokeStyle = 'rgba(120,96,62,0.28)';
    ctx.lineWidth = 3;
    ctx.strokeRect(x, 344, 96, 146);
  }

  // Tarnished brass chair rail
  ctx.fillStyle = '#9c7f43';
  ctx.fillRect(0, 316, 512, 10);
  ctx.fillStyle = '#4a3a1e';
  ctx.fillRect(0, 324, 512, 3);

  // Aged ivory peeling plaster patches & soot
  for (let i = 0; i < 65; i++) {
    const x = rand() * 512;
    const y = rand() * 310;
    const r = 8 + rand() * 36;
    const g = ctx.createRadialGradient(x, y, 2, x, y, r);
    g.addColorStop(0, rand() > 0.55 ? 'rgba(182,172,146,0.18)' : 'rgba(12,16,15,0.34)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  return makeCanvasTex(c, repeatX, repeatY, maxAniso, true);
}

/** Kino Art-Deco geometric cream & charcoal terrazzo foyer marble */
export function createKinoArtDecoTileTexture(
  maxAniso: number,
  repeatX = 6,
  repeatY = 4,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(1941);

  ctx.fillStyle = '#202426';
  ctx.fillRect(0, 0, 512, 512);

  const step = 128;
  for (let r = 0; r < 4; r++) {
    for (let col = 0; col < 4; col++) {
      const light = (r + col) % 2 === 0;
      ctx.fillStyle = light ? '#b4aa96' : '#252c2d';
      ctx.fillRect(col * step + 3, r * step + 3, step - 6, step - 6);

      // Brass diamond inlay at tile center
      ctx.strokeStyle = light ? 'rgba(146,120,68,0.42)' : 'rgba(172,146,88,0.28)';
      ctx.lineWidth = 2;
      const cx = col * step + step * 0.5;
      const cy = r * step + step * 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 28);
      ctx.lineTo(cx + 28, cy);
      ctx.lineTo(cx, cy + 28);
      ctx.lineTo(cx - 28, cy);
      ctx.closePath();
      ctx.stroke();
    }
  }

  for (let i = 0; i < 90; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const rad = 10 + rand() * 40;
    const g = ctx.createRadialGradient(x, y, 2, x, y, rad);
    g.addColorStop(0, 'rgba(18,22,20,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }

  return makeCanvasTex(c, repeatX, repeatY, maxAniso, true);
}

/** Copyright-safe vintage 1940s Art-Deco cinema poster for Kino visual easter eggs */
export function createKinoPosterTexture(
  title: string,
  subtitle: string,
  accentHex: string,
  maxAniso: number,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 384;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = '#181e20';
  ctx.fillRect(0, 0, 256, 384);

  // Double Art-Deco border
  ctx.strokeStyle = '#bfa05a';
  ctx.lineWidth = 6;
  ctx.strokeRect(12, 12, 232, 360);
  ctx.lineWidth = 2;
  ctx.strokeRect(22, 22, 212, 340);

  // Stylized geometric spotlight sunburst
  const grad = ctx.createRadialGradient(128, 165, 10, 128, 165, 110);
  grad.addColorStop(0, accentHex);
  grad.addColorStop(1, 'rgba(24,30,32,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(24, 54, 208, 220);

  ctx.strokeStyle = 'rgba(230,214,174,0.32)';
  ctx.lineWidth = 2;
  for (let i = -3; i <= 3; i++) {
    ctx.beginPath();
    ctx.moveTo(128, 250);
    ctx.lineTo(128 + i * 32, 65);
    ctx.stroke();
  }

  ctx.fillStyle = '#ece3cc';
  ctx.font = '700 26px "Oswald", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(title, 128, 298);

  ctx.fillStyle = '#bfa05a';
  ctx.font = '600 14px "IBM Plex Mono", monospace';
  ctx.fillText(subtitle, 128, 326);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, Math.max(1, maxAniso));
  tex.needsUpdate = true;
  return tex;
}

/** Copyright-safe chalk blackboard schematic (teleporter equations or ray-emitter blueprint) */
export function createChalkBlueprintTexture(
  header: string,
  variant: 'equations' | 'emitter',
  maxAniso: number,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = '#151b1a';
  ctx.fillRect(0, 0, 512, 256);
  ctx.strokeStyle = 'rgba(218,224,214,0.45)';
  ctx.lineWidth = 3;
  ctx.strokeRect(10, 10, 492, 236);

  ctx.fillStyle = '#dce8de';
  ctx.font = '700 22px "IBM Plex Mono", monospace';
  ctx.fillText(header, 28, 44);

  ctx.strokeStyle = '#9be7c8';
  ctx.lineWidth = 2.2;
  if (variant === 'equations') {
    ctx.font = '500 17px "IBM Plex Mono", monospace';
    ctx.fillStyle = '#c5d9cf';
    ctx.fillText('f_res = 115.0 Hz   Δt -> 0.004s', 28, 86);
    ctx.fillText('Φ(r) = ∫ B·dA  [LINK PAD -> BOOTH]', 28, 120);
    ctx.fillText('REEL #1 · REEL #2 · REEL #3', 28, 156);
    ctx.fillStyle = '#f2c779';
    ctx.fillText('WARNING: DO NOT SEVER MAIN BREAKER', 28, 206);
    // Resonance coil diagram
    ctx.beginPath();
    ctx.arc(415, 132, 52, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(415, 132, 30, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    // Stylized retro-scifi parabolic emitter chalk schematic
    ctx.beginPath();
    ctx.moveTo(64, 150);
    ctx.lineTo(130, 138);
    ctx.lineTo(310, 138);
    ctx.lineTo(378, 122);
    ctx.lineTo(378, 154);
    ctx.lineTo(310, 150);
    ctx.stroke();
    for (const rx of [328, 346, 364]) {
      ctx.beginPath();
      ctx.ellipse(rx, 138, 6, 18, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#9be7c8';
    ctx.font = '500 15px "IBM Plex Mono", monospace';
    ctx.fillText('PROTOTYPE MK-IV · WAVEGUIDE COIL', 28, 214);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, Math.max(1, maxAniso));
  tex.needsUpdate = true;
  return tex;
}

/** Korsakov Substation Option 3: Dark poured industrial slate concrete with formwork tie-rod holes */
export function createIndustrialSlateConcreteTexture(
  maxAniso: number,
  repeatX = 3,
  repeatY = 2,
  baseHex = '#414952',
  seed = 7701,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(seed);

  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, 512, 512);

  // Horizontal poured concrete formwork lifts
  for (let y = 0; y < 512; y += 128) {
    ctx.fillStyle = 'rgba(12,16,20,0.46)';
    ctx.fillRect(0, y, 512, 4);
    ctx.fillStyle = 'rgba(170,185,200,0.10)';
    ctx.fillRect(0, y + 4, 512, 2);
    // Recessed formwork tie holes
    for (let x = 64; x < 512; x += 128) {
      ctx.fillStyle = 'rgba(10,14,18,0.68)';
      ctx.beginPath();
      ctx.arc(x, y + 64, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (let x = 0; x < 512; x += 256) {
    ctx.fillStyle = 'rgba(10,14,18,0.34)';
    ctx.fillRect(x, 0, 3, 512);
  }

  // Industrial oil mist & mineral dampness
  for (let i = 0; i < 60; i++) {
    const x = rand() * 512;
    const y = rand() * 512;
    const r = 16 + rand() * 64;
    const g = ctx.createRadialGradient(x, y, 2, x, y, r);
    g.addColorStop(0, rand() > 0.4 ? 'rgba(16,20,26,0.24)' : 'rgba(148,164,178,0.09)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Hazard yellow-black lower industrial stripe option kept subtle
  for (let i = 0; i < 1800; i++) {
    const a = 0.04 + rand() * 0.08;
    ctx.fillStyle = rand() > 0.5 ? `rgba(14,18,22,${a})` : `rgba(180,192,205,${a * 0.65})`;
    ctx.fillRect(rand() * 512, rand() * 512, 2, 2);
  }

  return makeCanvasTex(c, repeatX, repeatY, maxAniso, true);
}

/** Runway / airstrip tarmac texture with tire-skid rubber marks */
export function createRunwayAsphaltTexture(
  maxAniso: number,
  repeatX = 4,
  repeatY = 16,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(8802);

  ctx.fillStyle = '#2d3135';
  ctx.fillRect(0, 0, 512, 512);

  // Subtle tire rubber wear along center
  for (let i = 0; i < 40; i++) {
    const x = 160 + rand() * 192;
    ctx.fillStyle = 'rgba(14,16,18,0.16)';
    ctx.fillRect(x, 0, 4 + rand() * 10, 512);
  }
  for (let i = 0; i < 2800; i++) {
    ctx.fillStyle = rand() > 0.5 ? 'rgba(110,116,122,0.12)' : 'rgba(12,14,16,0.20)';
    ctx.fillRect(rand() * 512, rand() * 512, 2, 2);
  }
  // Asphalt expansion seam
  ctx.fillStyle = 'rgba(16,18,20,0.55)';
  ctx.fillRect(0, 254, 512, 4);

  return makeCanvasTex(c, repeatX, repeatY, maxAniso, true);
}

/** Flowing alpine river water texture */
export function createRiverWaterTexture(
  maxAniso: number,
  repeatX = 2,
  repeatY = 18,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const rand = seededRand(3304);

  ctx.fillStyle = '#264754';
  ctx.fillRect(0, 0, 256, 256);

  // Longitudinal flow streaks & foam ripples
  for (let i = 0; i < 95; i++) {
    const x = rand() * 256;
    const y = rand() * 256;
    const w = 3 + rand() * 10;
    const h = 24 + rand() * 84;
    ctx.fillStyle = rand() > 0.6 ? 'rgba(148,196,210,0.18)' : 'rgba(18,44,54,0.32)';
    ctx.fillRect(x, y, w, h);
  }

  return makeCanvasTex(c, repeatX, repeatY, maxAniso, true);
}


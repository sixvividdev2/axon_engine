import * as THREE from 'three';
import { WeaponFinishPreset } from '../types';

export interface WeaponPBRMaterialLibrary {
  gunmetal: THREE.MeshStandardMaterial;
  anodized: THREE.MeshStandardMaterial;
  chromeSteel: THREE.MeshPhysicalMaterial;
  bluedSteel: THREE.MeshStandardMaterial;
  wornPolymer: THREE.MeshStandardMaterial;
  checkeredGrip: THREE.MeshStandardMaterial;
  recessedCavity: THREE.MeshStandardMaterial;
  sightWhiteDot: THREE.MeshStandardMaterial;
  bakelite: THREE.MeshStandardMaterial;
  laminatedWood: THREE.MeshStandardMaterial;
  walnutWood: THREE.MeshStandardMaterial;
  arcticRedLaminate: THREE.MeshStandardMaterial;
  peqFde: THREE.MeshStandardMaterial;
  ral8000Bronze: THREE.MeshStandardMaterial;
  odGreen: THREE.MeshStandardMaterial;
  olivePolymer: THREE.MeshStandardMaterial;
  translucentSmoke: THREE.MeshPhysicalMaterial;
  brass: THREE.MeshStandardMaterial;
  redShell: THREE.MeshStandardMaterial;
  tritiumGreen: THREE.MeshStandardMaterial;
  fiberOrange: THREE.MeshStandardMaterial;
  oliveFrag: THREE.MeshStandardMaterial;
  crowbarRed: THREE.MeshStandardMaterial;
  clothStrip: THREE.MeshStandardMaterial;
  lensGlass: THREE.MeshPhysicalMaterial;
  textures: THREE.Texture[];
}

let cachedMaterials: WeaponPBRMaterialLibrary | null = null;

function createCanvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  isColor: boolean,
  repeatX = 1,
  repeatY = 1,
): THREE.Texture {
  if (typeof document === 'undefined') {
    const data = new Uint8Array([180, 180, 180, 255]);
    const fallback = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    fallback.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    fallback.needsUpdate = true;
    return fallback;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    draw(ctx, width, height);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

export function getWeaponPBRMaterialLibrary(): WeaponPBRMaterialLibrary {
  if (cachedMaterials) return cachedMaterials;

  const textures: THREE.Texture[] = [];

  // 1. Satin / Parkerized Gunmetal albedo, roughness & subtle micro-grain bump
  const metalAlbedo = createCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = '#2b3038';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 820; i++) {
        const y = Math.random() * h;
        const lum = 34 + Math.floor(Math.random() * 28);
        ctx.fillStyle = `rgba(${lum},${lum + 3},${lum + 7},0.20)`;
        ctx.fillRect(0, y, w, 1 + Math.random() * 1.2);
      }
      // Subtle parkerized edge sheen patches
      for (let i = 0; i < 90; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        const r = 6 + Math.random() * 22;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(130,138,148,0.16)');
        g.addColorStop(1, 'rgba(34,38,44,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
    },
    true,
    2,
    2,
  );
  const metalRough = createCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = '#686868';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 720; i++) {
        const v = 76 + Math.floor(Math.random() * 68);
        ctx.fillStyle = `rgba(${v},${v},${v},0.30)`;
        ctx.fillRect(0, Math.random() * h, w, 1.4);
      }
    },
    false,
    2,
    2,
  );
  const metalBump = createCanvasTexture(
    128,
    128,
    (ctx, w, h) => {
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 2400; i++) {
        const v = 104 + Math.floor(Math.random() * 48);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
      }
    },
    false,
    3,
    3,
  );

  // 2. Directional Anisotropic Brushed Stainless / Chrome Steel (Desert Eagle, Revolvers, Bolts)
  const brushedSteelAlbedo = createCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = '#cfd5dc';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 1200; i++) {
        const y = Math.random() * h;
        const lum = 185 + Math.floor(Math.random() * 56);
        ctx.fillStyle = `rgba(${lum},${lum + 2},${lum + 5},0.28)`;
        ctx.fillRect(0, y, w, 0.9 + Math.random() * 1.1);
      }
      // Fine handling micro-scratches
      for (let i = 0; i < 160; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        ctx.fillStyle = 'rgba(250,252,255,0.22)';
        ctx.fillRect(x, y, 16 + Math.random() * 46, 0.8);
      }
    },
    true,
    2,
    2,
  );
  const brushedSteelRough = createCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = '#383838';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 950; i++) {
        const v = 34 + Math.floor(Math.random() * 44);
        ctx.fillStyle = `rgba(${v},${v},${v},0.35)`;
        ctx.fillRect(0, Math.random() * h, w, 1.1);
      }
    },
    false,
    2,
    2,
  );
  textures.push(metalAlbedo, metalRough, metalBump, brushedSteelAlbedo, brushedSteelRough);

  // 3. Stippled / Checkered Matte Polymer
  const polymerAlbedo = createCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = '#181a1e';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 5200; i++) {
        const v = 16 + Math.floor(Math.random() * 22);
        ctx.fillStyle = `rgb(${v},${v + 1},${v + 3})`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 1.8, 1.8);
      }
    },
    true,
    2,
    2,
  );
  const checkeringBump = createCanvasTexture(
    128,
    128,
    (ctx, w, h) => {
      ctx.fillStyle = '#3a3a3a';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#dadada';
      ctx.lineWidth = 2;
      const step = 9;
      for (let i = -h; i < w + h; i += step) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + h, h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i - h, h);
        ctx.stroke();
      }
    },
    false,
    4,
    4,
  );
  textures.push(polymerAlbedo, checkeringBump);

  // 4. Bakelite & Figured Walnut / Laminated Wood Grain + Roughness + Bump
  const bakeliteAlbedo = createCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, '#8d3e1c');
      grad.addColorStop(0.45, '#a84f24');
      grad.addColorStop(0.8, '#773116');
      grad.addColorStop(1, '#98441e');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 240; i++) {
        ctx.strokeStyle =
          i % 3 === 0 ? 'rgba(62,22,10,0.28)' : 'rgba(205,112,56,0.20)';
        ctx.lineWidth = 1 + Math.random() * 3.5;
        ctx.beginPath();
        const x0 = Math.random() * w;
        const y0 = Math.random() * h;
        ctx.moveTo(x0, y0);
        ctx.bezierCurveTo(
          x0 + (Math.random() - 0.5) * 60,
          y0 + 18,
          x0 + (Math.random() - 0.5) * 60,
          y0 + 44,
          x0 + (Math.random() - 0.5) * 35,
          y0 + 70,
        );
        ctx.stroke();
      }
    },
    true,
    1,
    1,
  );
  textures.push(bakeliteAlbedo);

  const woodAlbedo = createCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = '#6c3b1e';
      ctx.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 2) {
        const wave = Math.sin(y * 0.14) * 16 + Math.cos(y * 0.05) * 11 + Math.sin(y * 0.31) * 6;
        const r = Math.min(255, Math.max(0, 110 + Math.floor(wave)));
        const g = Math.min(255, Math.max(0, 58 + Math.floor(wave * 0.58)));
        const b = Math.min(255, Math.max(0, 27 + Math.floor(wave * 0.32)));
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(0, y, w, 2);
      }
      // Figured walnut pores & dark cathedral grain arcs
      for (let i = 0; i < 320; i++) {
        ctx.fillStyle = i % 4 === 0 ? 'rgba(182,114,62,0.14)' : 'rgba(26,12,5,0.24)';
        ctx.fillRect(Math.random() * w, Math.random() * h, 16 + Math.random() * 44, 1.2);
      }
    },
    true,
    1,
    1,
  );

  // Canadian Rangers Colt C19 Arctic Red-Orange Birch Laminate
  const arcticWoodAlbedo = createCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = '#a23819';
      ctx.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 3) {
        const stripe = y % 9 === 0 ? -24 : Math.sin(y * 0.16) * 16;
        const r = Math.min(255, Math.max(0, 168 + Math.floor(stripe)));
        const g = Math.min(255, Math.max(0, 56 + Math.floor(stripe * 0.45)));
        const b = Math.min(255, Math.max(0, 22 + Math.floor(stripe * 0.25)));
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(0, y, w, 3);
      }
    },
    true,
    1,
    1,
  );

  const woodRough = createCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = '#929292';
      ctx.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 2) {
        const v = 128 + Math.floor(Math.sin(y * 0.22) * 32 + Math.cos(y * 0.08) * 14);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(0, y, w, 2);
      }
    },
    false,
    1,
    1,
  );
  textures.push(woodAlbedo, arcticWoodAlbedo, woodRough);

  cachedMaterials = {
    gunmetal: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: metalAlbedo,
      roughnessMap: metalRough,
      bumpMap: metalBump,
      bumpScale: 0.0007,
      metalness: 0.78,
      roughness: 0.40,
    }),
    anodized: new THREE.MeshStandardMaterial({
      color: 0x22262c,
      roughnessMap: metalRough,
      bumpMap: metalBump,
      bumpScale: 0.0005,
      metalness: 0.76,
      roughness: 0.38,
    }),
    chromeSteel: new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: brushedSteelAlbedo,
      roughnessMap: brushedSteelRough,
      bumpMap: brushedSteelRough,
      bumpScale: 0.0006,
      metalness: 0.92,
      roughness: 0.20,
      anisotropy: 0.72,
      anisotropyRotation: 0,
      clearcoat: 0.08,
      clearcoatRoughness: 0.25,
    }),
    bluedSteel: new THREE.MeshStandardMaterial({
      color: 0x1d2635,
      roughnessMap: metalRough,
      bumpMap: metalBump,
      bumpScale: 0.0004,
      metalness: 0.88,
      roughness: 0.28,
    }),
    wornPolymer: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: polymerAlbedo,
      bumpMap: metalBump,
      bumpScale: 0.0008,
      metalness: 0.05,
      roughness: 0.84,
    }),
    checkeredGrip: new THREE.MeshStandardMaterial({
      color: 0x1e2126,
      map: polymerAlbedo,
      bumpMap: checkeringBump,
      bumpScale: 0.0032,
      metalness: 0.05,
      roughness: 0.86,
    }),
    recessedCavity: new THREE.MeshStandardMaterial({
      color: 0x08080a,
      metalness: 0.0,
      roughness: 0.96,
    }),
    sightWhiteDot: new THREE.MeshStandardMaterial({
      color: 0xf4f7f8,
      emissive: 0xdff7ea,
      emissiveIntensity: 0.48,
      roughness: 0.28,
      metalness: 0.0,
    }),
    bakelite: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: bakeliteAlbedo,
      bumpMap: woodRough,
      bumpScale: 0.0008,
      metalness: 0.06,
      roughness: 0.44,
    }),
    laminatedWood: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: woodAlbedo,
      roughnessMap: woodRough,
      bumpMap: woodRough,
      bumpScale: 0.0014,
      metalness: 0.04,
      roughness: 0.62,
    }),
    walnutWood: new THREE.MeshStandardMaterial({
      color: 0xb88668,
      map: woodAlbedo,
      roughnessMap: woodRough,
      bumpMap: woodRough,
      bumpScale: 0.0016,
      metalness: 0.04,
      roughness: 0.56,
    }),
    arcticRedLaminate: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: arcticWoodAlbedo,
      roughnessMap: woodRough,
      bumpMap: woodRough,
      bumpScale: 0.0012,
      metalness: 0.04,
      roughness: 0.52,
    }),
    peqFde: new THREE.MeshStandardMaterial({
      color: 0x8b7b5c,
      roughnessMap: metalRough,
      metalness: 0.34,
      roughness: 0.52,
    }),
    ral8000Bronze: new THREE.MeshStandardMaterial({
      color: 0x7a6544,
      roughnessMap: metalRough,
      metalness: 0.52,
      roughness: 0.38,
    }),
    odGreen: new THREE.MeshStandardMaterial({
      color: 0x424f3c,
      roughnessMap: metalRough,
      metalness: 0.24,
      roughness: 0.58,
    }),
    olivePolymer: new THREE.MeshStandardMaterial({
      color: 0x454a3b,
      roughnessMap: metalRough,
      metalness: 0.08,
      roughness: 0.76,
    }),
    translucentSmoke: new THREE.MeshPhysicalMaterial({
      color: 0x484d54,
      metalness: 0.05,
      roughness: 0.18,
      transparent: true,
      opacity: 0.52,
      depthWrite: false,
    }),
    brass: new THREE.MeshStandardMaterial({
      color: 0xd8b153,
      metalness: 0.92,
      roughness: 0.22,
    }),
    redShell: new THREE.MeshStandardMaterial({
      color: 0x8f1f1b,
      metalness: 0.08,
      roughness: 0.46,
    }),
    tritiumGreen: new THREE.MeshStandardMaterial({
      color: 0x7eff9a,
      emissive: 0x35ff6c,
      emissiveIntensity: 1.6,
      roughness: 0.22,
      metalness: 0.0,
    }),
    fiberOrange: new THREE.MeshStandardMaterial({
      color: 0xff6e2b,
      emissive: 0xff4512,
      emissiveIntensity: 1.5,
      roughness: 0.22,
      metalness: 0.0,
    }),
    oliveFrag: new THREE.MeshStandardMaterial({
      color: 0x3b4831,
      metalness: 0.26,
      roughness: 0.64,
    }),
    crowbarRed: new THREE.MeshStandardMaterial({
      color: 0x6f2822,
      metalness: 0.36,
      roughness: 0.58,
    }),
    clothStrip: new THREE.MeshStandardMaterial({
      color: 0x998e75,
      metalness: 0.02,
      roughness: 0.94,
    }),
    lensGlass: new THREE.MeshPhysicalMaterial({
      color: 0x8fd6ff,
      metalness: 0.1,
      roughness: 0.08,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
    textures,
  };
  return cachedMaterials;
}

export interface FinishMaterialSet {
  receiver: THREE.Material;
  furniture: THREE.Material;
  barrel: THREE.Material;
  bolt: THREE.Material;
}

export function resolveFinishMaterials(
  mats: WeaponPBRMaterialLibrary,
  finish?: WeaponFinishPreset,
): FinishMaterialSet {
  switch (finish) {
    case 'fde_tan':
      return {
        receiver: mats.peqFde,
        furniture: mats.peqFde,
        barrel: mats.anodized,
        bolt: mats.gunmetal,
      };
    case 'ral8000_bronze':
      return {
        receiver: mats.ral8000Bronze,
        furniture: mats.peqFde,
        barrel: mats.anodized,
        bolt: mats.gunmetal,
      };
    case 'od_green':
      return {
        receiver: mats.anodized,
        furniture: mats.odGreen,
        barrel: mats.gunmetal,
        bolt: mats.chromeSteel,
      };
    case 'arctic_red_laminate':
      return {
        receiver: mats.chromeSteel,
        furniture: mats.arcticRedLaminate,
        barrel: mats.chromeSteel,
        bolt: mats.chromeSteel,
      };
    case 'walnut':
      return {
        receiver: mats.gunmetal,
        furniture: mats.walnutWood,
        barrel: mats.bluedSteel,
        bolt: mats.chromeSteel,
      };
    case 'stainless':
      return {
        receiver: mats.chromeSteel,
        furniture: mats.wornPolymer,
        barrel: mats.chromeSteel,
        bolt: mats.chromeSteel,
      };
    case 'chrome':
      return {
        receiver: mats.chromeSteel,
        furniture: mats.checkeredGrip,
        barrel: mats.chromeSteel,
        bolt: mats.chromeSteel,
      };
    case 'blued_steel':
      return {
        receiver: mats.bluedSteel,
        furniture: mats.walnutWood,
        barrel: mats.bluedSteel,
        bolt: mats.gunmetal,
      };
    case 'olive_polymer':
      return {
        receiver: mats.olivePolymer,
        furniture: mats.olivePolymer,
        barrel: mats.anodized,
        bolt: mats.gunmetal,
      };
    case 'parkerized':
      return {
        receiver: mats.gunmetal,
        furniture: mats.wornPolymer,
        barrel: mats.gunmetal,
        bolt: mats.chromeSteel,
      };
    case 'black_anodized':
    default:
      return {
        receiver: mats.anodized,
        furniture: mats.wornPolymer,
        barrel: mats.gunmetal,
        bolt: mats.chromeSteel,
      };
  }
}

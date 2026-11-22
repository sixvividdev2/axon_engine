import * as THREE from 'three';
import { WeaponFinishPreset } from '../types';

export interface WeaponPBRMaterialLibrary {
  gunmetal: THREE.MeshStandardMaterial;
  anodized: THREE.MeshStandardMaterial;
  chromeSteel: THREE.MeshStandardMaterial;
  bluedSteel: THREE.MeshStandardMaterial;
  wornPolymer: THREE.MeshStandardMaterial;
  checkeredGrip: THREE.MeshStandardMaterial;
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
): THREE.CanvasTexture {
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

  const metalAlbedo = createCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = '#272b30';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 650; i++) {
        const y = Math.random() * h;
        const lum = 34 + Math.floor(Math.random() * 26);
        ctx.fillStyle = `rgba(${lum},${lum + 3},${lum + 6},0.22)`;
        ctx.fillRect(0, y, w, 1 + Math.random() * 1.4);
      }
      for (let i = 0; i < 70; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        const r = 6 + Math.random() * 22;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(115,122,130,0.16)');
        g.addColorStop(1, 'rgba(35,38,42,0)');
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
      ctx.fillStyle = '#626262';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 500; i++) {
        const v = 70 + Math.floor(Math.random() * 65);
        ctx.fillStyle = `rgba(${v},${v},${v},0.3)`;
        ctx.fillRect(0, Math.random() * h, w, 1.5);
      }
    },
    false,
    2,
    2,
  );
  textures.push(metalAlbedo, metalRough);

  const polymerAlbedo = createCanvasTexture(
    256,
    256,
    (ctx, w, h) => {
      ctx.fillStyle = '#1b1d20';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 4200; i++) {
        const v = 18 + Math.floor(Math.random() * 24);
        ctx.fillStyle = `rgb(${v},${v + 1},${v + 2})`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
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
      ctx.fillStyle = '#404040';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#d4d4d4';
      ctx.lineWidth = 2;
      const step = 10;
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
      ctx.fillStyle = '#6f3e20';
      ctx.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 2) {
        const wave = Math.sin(y * 0.14) * 14 + Math.cos(y * 0.05) * 9;
        const r = Math.min(255, Math.max(0, 112 + Math.floor(wave)));
        const g = Math.min(255, Math.max(0, 60 + Math.floor(wave * 0.6)));
        const b = Math.min(255, Math.max(0, 29 + Math.floor(wave * 0.35)));
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(0, y, w, 2);
      }
      for (let i = 0; i < 260; i++) {
        ctx.fillStyle = 'rgba(28,14,6,0.22)';
        ctx.fillRect(Math.random() * w, Math.random() * h, 14 + Math.random() * 40, 1);
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
      ctx.fillStyle = '#9a9a9a';
      ctx.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 3) {
        const v = 135 + Math.floor(Math.sin(y * 0.2) * 28);
        ctx.fillStyle = `rgb(${v},${v},${v})`;
        ctx.fillRect(0, y, w, 3);
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
      metalness: 0.86,
      roughness: 0.36,
    }),
    anodized: new THREE.MeshStandardMaterial({
      color: 0x1e2227,
      roughnessMap: metalRough,
      metalness: 0.80,
      roughness: 0.30,
    }),
    chromeSteel: new THREE.MeshStandardMaterial({
      color: 0xc8cfd6,
      metalness: 0.94,
      roughness: 0.18,
    }),
    bluedSteel: new THREE.MeshStandardMaterial({
      color: 0x1f2836,
      roughnessMap: metalRough,
      metalness: 0.90,
      roughness: 0.26,
    }),
    wornPolymer: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: polymerAlbedo,
      metalness: 0.08,
      roughness: 0.76,
    }),
    checkeredGrip: new THREE.MeshStandardMaterial({
      color: 0x202327,
      map: polymerAlbedo,
      bumpMap: checkeringBump,
      bumpScale: 0.0028,
      metalness: 0.06,
      roughness: 0.84,
    }),
    bakelite: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: bakeliteAlbedo,
      metalness: 0.06,
      roughness: 0.44,
    }),
    laminatedWood: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: woodAlbedo,
      roughnessMap: woodRough,
      metalness: 0.04,
      roughness: 0.62,
    }),
    walnutWood: new THREE.MeshStandardMaterial({
      color: 0xb88668,
      map: woodAlbedo,
      roughnessMap: woodRough,
      metalness: 0.05,
      roughness: 0.56,
    }),
    arcticRedLaminate: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: arcticWoodAlbedo,
      roughnessMap: woodRough,
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
      metalness: 0.10,
      roughness: 0.72,
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
      emissiveIntensity: 2.3,
      roughness: 0.2,
      metalness: 0.0,
    }),
    fiberOrange: new THREE.MeshStandardMaterial({
      color: 0xff6e2b,
      emissive: 0xff4512,
      emissiveIntensity: 2.0,
      roughness: 0.2,
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

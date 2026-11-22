import * as THREE from 'three';

export interface ProceduralPBRSet {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  dispose: () => void;
}

function hash2D(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
  return n - Math.floor(n);
}

function valueNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2D(ix, iy, seed);
  const b = hash2D(ix + 1, iy, seed);
  const c = hash2D(ix, iy + 1, seed);
  const d = hash2D(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let val = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    val += amp * valueNoise2D(x * freq, y * freq, seed + i * 19);
    freq *= 2.02;
    amp *= 0.5;
  }
  return val;
}

function heightToNormalCanvas(heightData: Float32Array, size: number, strength: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const d = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const ym = (y - 1 + size) % size;
      const yp = (y + 1) % size;

      const dx = (heightData[y * size + xp] - heightData[y * size + xm]) * strength;
      const dy = (heightData[yp * size + x] - heightData[ym * size + x]) * strength;
      const nz = 1.0;
      const len = Math.sqrt(dx * dx + dy * dy + nz * nz);

      const idx = (y * size + x) * 4;
      d[idx] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      d[idx + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      d[idx + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
      d[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function configureTexture(
  canvas: HTMLCanvasElement,
  isColor: boolean,
  repeatX: number,
  repeatY: number,
  maxAniso: number,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = maxAniso;
  if (isColor) {
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  tex.needsUpdate = true;
  return tex;
}

export class ProceduralTextureLibrary {
  public readonly concrete: ProceduralPBRSet;
  public readonly wood: ProceduralPBRSet;
  public readonly rustedMetal: ProceduralPBRSet;
  public readonly asphalt: ProceduralPBRSet;
  public readonly grass: ProceduralPBRSet;
  private maxAniso: number;

  constructor(renderer: THREE.WebGLRenderer, seed = 404) {
    this.maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.concrete = this.buildWetConcrete(seed + 11);
    this.wood = this.buildWeatheredWood(seed + 23);
    this.rustedMetal = this.buildRustedMetal(seed + 37);
    this.asphalt = this.buildWetAsphalt(seed + 53);
    this.grass = this.buildOvergrownGrass(seed + 71);
  }

  private buildWetConcrete(seed: number): ProceduralPBRSet {
    const size = 256;
    const albedo = document.createElement('canvas');
    albedo.width = size;
    albedo.height = size;
    const actx = albedo.getContext('2d')!;
    const aimg = actx.createImageData(size, size);

    const rough = document.createElement('canvas');
    rough.width = size;
    rough.height = size;
    const rctx = rough.getContext('2d')!;
    const rimg = rctx.createImageData(size, size);

    const heights = new Float32Array(size * size);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const n1 = fbm(x * 0.045, y * 0.045, seed, 4);
        const n2 = fbm(x * 0.16, y * 0.16, seed + 5, 3);
        const dampPatch = fbm(x * 0.018, y * 0.018, seed + 99, 3);
        const crackNoise = Math.abs(fbm(x * 0.06, y * 0.06, seed + 31, 3) - 0.5);
        const crack = crackNoise < 0.022 ? (1 - crackNoise / 0.022) : 0;

        const base = 92 + (n1 - 0.5) * 34 + (n2 - 0.5) * 18;
        const wetness = dampPatch > 0.54 ? (dampPatch - 0.54) * 1.6 : 0;
        const lum = Math.max(24, Math.min(200, base * (1 - wetness * 0.38) - crack * 46));

        const idx = (y * size + x) * 4;
        // Slight mossy olive-gray cast
        aimg.data[idx] = Math.round(lum * 0.96);
        aimg.data[idx + 1] = Math.round(lum * 0.99);
        aimg.data[idx + 2] = Math.round(lum * 0.94);
        aimg.data[idx + 3] = 255;

        const rVal = Math.max(45, Math.min(245, 218 - wetness * 145 + crack * 25 + (n2 - 0.5) * 30));
        rimg.data[idx] = rVal;
        rimg.data[idx + 1] = rVal;
        rimg.data[idx + 2] = rVal;
        rimg.data[idx + 3] = 255;

        heights[y * size + x] = n1 * 0.5 + n2 * 0.3 - crack * 0.8;
      }
    }
    actx.putImageData(aimg, 0, 0);
    rctx.putImageData(rimg, 0, 0);
    const normalCanvas = heightToNormalCanvas(heights, size, 3.2);

    const map = configureTexture(albedo, true, 2, 2, this.maxAniso);
    const normalMap = configureTexture(normalCanvas, false, 2, 2, this.maxAniso);
    const roughnessMap = configureTexture(rough, false, 2, 2, this.maxAniso);
    return {
      map,
      normalMap,
      roughnessMap,
      dispose: () => {
        map.dispose();
        normalMap.dispose();
        roughnessMap.dispose();
      },
    };
  }

  private buildWeatheredWood(seed: number): ProceduralPBRSet {
    const size = 256;
    const albedo = document.createElement('canvas');
    albedo.width = size;
    albedo.height = size;
    const actx = albedo.getContext('2d')!;
    const aimg = actx.createImageData(size, size);

    const rough = document.createElement('canvas');
    rough.width = size;
    rough.height = size;
    const rctx = rough.getContext('2d')!;
    const rimg = rctx.createImageData(size, size);

    const heights = new Float32Array(size * size);
    const plankCount = 6;
    const plankW = size / plankCount;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const plankIdx = Math.floor(x / plankW);
        const plankLocalX = x % plankW;
        const seam = plankLocalX < 2 || plankLocalX > plankW - 2 ? 1 : 0;

        const grain = fbm(x * 0.25, y * 0.03 + plankIdx * 7.3, seed, 4);
        const rings = Math.sin((x * 0.45 + grain * 6.0) * 0.8) * 0.5 + 0.5;
        const rot = fbm(x * 0.03, y * 0.03, seed + 44, 3);
        const plankTint = 0.88 + hash2D(plankIdx, 1, seed) * 0.24;

        const r = (74 + rings * 28 + grain * 18) * plankTint * (1 - rot * 0.25) * (seam ? 0.42 : 1);
        const g = (62 + rings * 22 + grain * 14) * plankTint * (1 - rot * 0.2) * (seam ? 0.42 : 1);
        const b = (49 + rings * 16 + grain * 10) * plankTint * (1 - rot * 0.22) * (seam ? 0.42 : 1);

        const idx = (y * size + x) * 4;
        aimg.data[idx] = Math.min(255, Math.max(12, Math.round(r)));
        aimg.data[idx + 1] = Math.min(255, Math.max(12, Math.round(g)));
        aimg.data[idx + 2] = Math.min(255, Math.max(12, Math.round(b)));
        aimg.data[idx + 3] = 255;

        const rVal = Math.round(Math.min(250, Math.max(120, 195 + rings * 30 - rot * 30)));
        rimg.data[idx] = rVal;
        rimg.data[idx + 1] = rVal;
        rimg.data[idx + 2] = rVal;
        rimg.data[idx + 3] = 255;

        heights[y * size + x] = rings * 0.35 + grain * 0.35 - seam * 0.75;
      }
    }
    actx.putImageData(aimg, 0, 0);
    rctx.putImageData(rimg, 0, 0);
    const normalCanvas = heightToNormalCanvas(heights, size, 3.6);

    const map = configureTexture(albedo, true, 1, 1, this.maxAniso);
    const normalMap = configureTexture(normalCanvas, false, 1, 1, this.maxAniso);
    const roughnessMap = configureTexture(rough, false, 1, 1, this.maxAniso);
    return {
      map,
      normalMap,
      roughnessMap,
      dispose: () => {
        map.dispose();
        normalMap.dispose();
        roughnessMap.dispose();
      },
    };
  }

  private buildRustedMetal(seed: number): ProceduralPBRSet {
    const size = 256;
    const albedo = document.createElement('canvas');
    albedo.width = size;
    albedo.height = size;
    const actx = albedo.getContext('2d')!;
    const aimg = actx.createImageData(size, size);

    const rough = document.createElement('canvas');
    rough.width = size;
    rough.height = size;
    const rctx = rough.getContext('2d')!;
    const rimg = rctx.createImageData(size, size);

    const heights = new Float32Array(size * size);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const rustPatch = fbm(x * 0.04, y * 0.04, seed, 4);
        const pit = fbm(x * 0.18, y * 0.18, seed + 17, 3);
        const isRust = rustPatch > 0.46 ? Math.min(1, (rustPatch - 0.46) * 2.5) : 0;

        const steel = 62 + pit * 22;
        const rustR = 96 + pit * 36;
        const rustG = 46 + pit * 18;
        const rustB = 28 + pit * 10;

        const idx = (y * size + x) * 4;
        aimg.data[idx] = Math.round(steel * (1 - isRust) + rustR * isRust);
        aimg.data[idx + 1] = Math.round(steel * (1 - isRust) + rustG * isRust);
        aimg.data[idx + 2] = Math.round((steel + 6) * (1 - isRust) + rustB * isRust);
        aimg.data[idx + 3] = 255;

        const rVal = Math.round(115 * (1 - isRust) + 225 * isRust + (pit - 0.5) * 25);
        rimg.data[idx] = rVal;
        rimg.data[idx + 1] = rVal;
        rimg.data[idx + 2] = rVal;
        rimg.data[idx + 3] = 255;

        heights[y * size + x] = pit * 0.4 + isRust * 0.35;
      }
    }
    actx.putImageData(aimg, 0, 0);
    rctx.putImageData(rimg, 0, 0);
    const normalCanvas = heightToNormalCanvas(heights, size, 2.8);

    const map = configureTexture(albedo, true, 1, 1, this.maxAniso);
    const normalMap = configureTexture(normalCanvas, false, 1, 1, this.maxAniso);
    const roughnessMap = configureTexture(rough, false, 1, 1, this.maxAniso);
    return {
      map,
      normalMap,
      roughnessMap,
      dispose: () => {
        map.dispose();
        normalMap.dispose();
        roughnessMap.dispose();
      },
    };
  }

  private buildWetAsphalt(seed: number): ProceduralPBRSet {
    const size = 256;
    const albedo = document.createElement('canvas');
    albedo.width = size;
    albedo.height = size;
    const actx = albedo.getContext('2d')!;
    const aimg = actx.createImageData(size, size);

    const rough = document.createElement('canvas');
    rough.width = size;
    rough.height = size;
    const rctx = rough.getContext('2d')!;
    const rimg = rctx.createImageData(size, size);

    const heights = new Float32Array(size * size);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const aggregate = hash2D(x, y, seed) * 0.35 + fbm(x * 0.22, y * 0.22, seed + 8, 3) * 0.65;
        const puddle = fbm(x * 0.022, y * 0.022, seed + 66, 3);
        const crackNoise = Math.abs(fbm(x * 0.045, y * 0.045, seed + 91, 3) - 0.5);
        const crack = crackNoise < 0.018 ? 1 - crackNoise / 0.018 : 0;

        // Center faded road stripe
        const inStripe = Math.abs(x - size / 2) < 5 && (y % 64) < 34;
        const wet = puddle > 0.56 ? Math.min(1, (puddle - 0.56) * 2.4) : 0;

        let base = 44 + aggregate * 24 - crack * 26;
        base *= 1 - wet * 0.38;

        let r = base;
        let g = base + 1;
        let b = base + 3;

        if (inStripe) {
          const wear = aggregate;
          r = r * 0.4 + 148 * 0.6 * wear;
          g = g * 0.4 + 138 * 0.6 * wear;
          b = b * 0.4 + 88 * 0.6 * wear;
        }

        const idx = (y * size + x) * 4;
        aimg.data[idx] = Math.max(14, Math.min(220, Math.round(r)));
        aimg.data[idx + 1] = Math.max(14, Math.min(220, Math.round(g)));
        aimg.data[idx + 2] = Math.max(14, Math.min(220, Math.round(b)));
        aimg.data[idx + 3] = 255;

        const rVal = Math.max(32, Math.min(245, Math.round(215 - wet * 165 + crack * 20)));
        rimg.data[idx] = rVal;
        rimg.data[idx + 1] = rVal;
        rimg.data[idx + 2] = rVal;
        rimg.data[idx + 3] = 255;

        heights[y * size + x] = aggregate * 0.5 * (1 - wet * 0.8) - crack * 0.9;
      }
    }
    actx.putImageData(aimg, 0, 0);
    rctx.putImageData(rimg, 0, 0);
    const normalCanvas = heightToNormalCanvas(heights, size, 2.5);

    const map = configureTexture(albedo, true, 1, 14, this.maxAniso);
    const normalMap = configureTexture(normalCanvas, false, 1, 14, this.maxAniso);
    const roughnessMap = configureTexture(rough, false, 1, 14, this.maxAniso);
    return {
      map,
      normalMap,
      roughnessMap,
      dispose: () => {
        map.dispose();
        normalMap.dispose();
        roughnessMap.dispose();
      },
    };
  }

  private buildOvergrownGrass(seed: number): ProceduralPBRSet {
    const size = 256;
    const albedo = document.createElement('canvas');
    albedo.width = size;
    albedo.height = size;
    const actx = albedo.getContext('2d')!;
    const aimg = actx.createImageData(size, size);

    const rough = document.createElement('canvas');
    rough.width = size;
    rough.height = size;
    const rctx = rough.getContext('2d')!;
    const rimg = rctx.createImageData(size, size);

    const heights = new Float32Array(size * size);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const patch = fbm(x * 0.03, y * 0.03, seed, 4);
        const blades = fbm(x * 0.3, y * 0.14, seed + 12, 3);
        const mud = patch < 0.40 ? (0.40 - patch) * 2.5 : 0;

        // Bleached post-apocalyptic olive-ochre grass + dark damp soil
        const grassR = 64 + blades * 34 + patch * 16;
        const grassG = 72 + blades * 32 + patch * 10;
        const grassB = 46 + blades * 14;

        const mudR = 52 + blades * 14;
        const mudG = 46 + blades * 12;
        const mudB = 36 + blades * 10;

        const idx = (y * size + x) * 4;
        aimg.data[idx] = Math.round(grassR * (1 - mud) + mudR * mud);
        aimg.data[idx + 1] = Math.round(grassG * (1 - mud) + mudG * mud);
        aimg.data[idx + 2] = Math.round(grassB * (1 - mud) + mudB * mud);
        aimg.data[idx + 3] = 255;

        const rVal = Math.round(230 - mud * 45);
        rimg.data[idx] = rVal;
        rimg.data[idx + 1] = rVal;
        rimg.data[idx + 2] = rVal;
        rimg.data[idx + 3] = 255;

        heights[y * size + x] = blades * 0.55 * (1 - mud) + patch * 0.25;
      }
    }
    actx.putImageData(aimg, 0, 0);
    rctx.putImageData(rimg, 0, 0);
    const normalCanvas = heightToNormalCanvas(heights, size, 2.4);

    const map = configureTexture(albedo, true, 28, 28, this.maxAniso);
    const normalMap = configureTexture(normalCanvas, false, 28, 28, this.maxAniso);
    const roughnessMap = configureTexture(rough, false, 28, 28, this.maxAniso);
    return {
      map,
      normalMap,
      roughnessMap,
      dispose: () => {
        map.dispose();
        normalMap.dispose();
        roughnessMap.dispose();
      },
    };
  }

  public dispose(): void {
    this.concrete.dispose();
    this.wood.dispose();
    this.rustedMetal.dispose();
    this.asphalt.dispose();
    this.grass.dispose();
  }
}

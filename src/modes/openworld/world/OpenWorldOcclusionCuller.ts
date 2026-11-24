import * as THREE from 'three';
import type { SolidObb } from './OpenWorldCivilizationTopology';

export interface OcclusionCullerStats {
  occluderCount: number;
  rasterizedFaces: number;
  testedCount: number;
  occludedCount: number;
  coverageRatio: number;
}

const OCCL_WIDTH = 64;
const OCCL_HEIGHT = 36;
const OCCL_PIXELS = OCCL_WIDTH * OCCL_HEIGHT;

// 8x8 coarse Hi-Z max-depth blocks covering 64x36 (8 cols x 5 rows)
const COARSE_SHIFT = 3;
const COARSE_W = OCCL_WIDTH >> COARSE_SHIFT; // 8
const COARSE_H = (OCCL_HEIGHT + 7) >> COARSE_SHIFT; // 5

// Conservative depth bias in NDC [-1, 1] space to prevent any self-occlusion or Z-precision flicker
const DEPTH_BIAS = 0.0012;

// Minimum physical dimensions for an OBB wall/building segment to act as a solid occluder
const MIN_OCCLUDER_HALF_HEIGHT_M = 1.05; // >= 2.1m tall
const MIN_OCCLUDER_HALF_SPAN_M = 1.25; // >= 2.5m wide or deep
const DEFAULT_OBB_MAX_DIST_M = 220.0;
const DEFAULT_LANDMARK_MAX_DIST_M = 1150.0;

// 6 box faces (corner index order CCW when viewed from outside) + local outward axis sign
// Corner bit layout: bit0 = +X, bit1 = +Y, bit2 = +Z
const FACE_INDICES = new Uint8Array([
  // +X face (x = +hx): corners 1, 3, 7, 5
  1, 3, 7, 5,
  // -X face (x = -hx): corners 0, 4, 6, 2
  0, 4, 6, 2,
  // +Y face (y = +hy): corners 2, 6, 7, 3
  2, 6, 7, 3,
  // -Y face (y = -hy): corners 0, 1, 5, 4
  0, 1, 5, 4,
  // +Z face (z = +hz): corners 4, 5, 7, 6
  4, 5, 7, 6,
  // -Z face (z = -hz): corners 0, 2, 3, 1
  0, 2, 3, 1,
]);

/**
 * Returns true if a SolidObb represents a large opaque structural wall/building segment
 * suitable for conservative software occlusion culling (leaves open doorways & windows clear
 * because enterable buildings split walls into distinct solid OBB segments around openings).
 */
export function isEligibleOccluderObb(obb: SolidObb): boolean {
  if (!obb.blocksBullets) return false;
  if (obb.hy < MIN_OCCLUDER_HALF_HEIGHT_M) return false;
  return obb.hx >= MIN_OCCLUDER_HALF_SPAN_M || obb.hz >= MIN_OCCLUDER_HALF_SPAN_M;
}

/**
 * Zero-GC Conservative Software Hi-Z Occlusion Culler (`64 × 36` depth buffer + `8 × 5` coarse mip).
 *
 * - Rasterizes front-facing quads of large solid building walls, FOB blast walls, shipping
 *   containers, and major vertical landmarks (Dam, Port, Quarry, Railyard) with exact
 *   Sutherland-Hodgman near-plane clipping and conservative full-pixel coverage tests.
 * - Because adjacent wall segments seamlessly merge in the depth buffer while doorways and
 *   windows stay open (`depth = 1.0`), assets behind L-shaped walls or whole compounds are
 *   cleanly occluded with zero WebGL sync stalls and zero false pop-out through openings.
 */
export class OpenWorldOcclusionCuller {
  private readonly depthBuf = new Float32Array(OCCL_PIXELS);
  private readonly coarseMax = new Float32Array(COARSE_W * COARSE_H);
  private readonly vpMatrix = new THREE.Matrix4();

  // Pre-allocated scratch buffers (zero per-frame heap allocations)
  private readonly corners = new Float32Array(8 * 3);
  private readonly inX = new Float32Array(8);
  private readonly inY = new Float32Array(8);
  private readonly inZ = new Float32Array(8);
  private readonly inW = new Float32Array(8);
  private readonly outX = new Float32Array(8);
  private readonly outY = new Float32Array(8);
  private readonly outZ = new Float32Array(8);
  private readonly outW = new Float32Array(8);
  private readonly polySx = new Float32Array(8);
  private readonly polySy = new Float32Array(8);
  private readonly polySz = new Float32Array(8);
  private readonly sphereBoxScratch = new THREE.Box3();

  private camX = 0;
  private camY = 0;
  private camZ = 0;
  private nearPlane = 0.1;
  private finalized = false;

  private occluderCount = 0;
  private rasterizedFaces = 0;
  private testedCount = 0;
  private occludedCount = 0;
  private coveredPixelCount = 0;

  /**
   * Begins a new frame's occlusion pass by clearing the depth grid and caching view-projection.
   */
  public beginFrame(
    camera: THREE.PerspectiveCamera,
    camX: number,
    camY: number,
    camZ: number,
  ): void {
    camera.updateMatrixWorld();
    this.vpMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.camX = camX;
    this.camY = camY;
    this.camZ = camZ;
    this.nearPlane = Math.max(0.08, camera.near);
    this.depthBuf.fill(1.0);
    this.finalized = false;
    this.occluderCount = 0;
    this.rasterizedFaces = 0;
    this.testedCount = 0;
    this.occludedCount = 0;
    this.coveredPixelCount = 0;
  }

  /**
   * Rasterizes a large solid structural OBB into the conservative depth buffer.
   */
  public addOccluderObb(obb: SolidObb, maxDistM = DEFAULT_OBB_MAX_DIST_M): void {
    if (!isEligibleOccluderObb(obb)) return;

    const dx = this.camX - obb.cx;
    const dy = this.camY - obb.cy;
    const dz = this.camZ - obb.cz;
    const maxRadius = obb.hx + obb.hy + obb.hz;
    const maxD = maxDistM + maxRadius;
    if (dx * dx + dy * dy + dz * dz > maxD * maxD) return;

    // Transform camera into OBB local space to reject when camera is inside/touching the occluder
    const localCamX = dx * obb.cosY - dz * obb.sinY;
    const localCamZ = dx * obb.sinY + dz * obb.cosY;
    if (
      Math.abs(localCamX) <= obb.hx + 0.18 &&
      Math.abs(dy) <= obb.hy + 0.18 &&
      Math.abs(localCamZ) <= obb.hz + 0.18
    ) {
      return;
    }

    // Local +X = (cosY, 0, -sinY), Local +Z = (sinY, 0, cosY)
    const rx = obb.cosY * obb.hx;
    const rz = -obb.sinY * obb.hx;
    const fx = obb.sinY * obb.hz;
    const fz = obb.cosY * obb.hz;
    const hy = obb.hy;

    // Build 8 world-space corners
    for (let c = 0; c < 8; c++) {
      const sx = (c & 1) !== 0 ? 1 : -1;
      const sy = (c & 2) !== 0 ? 1 : -1;
      const sz = (c & 4) !== 0 ? 1 : -1;
      const o = c * 3;
      this.corners[o] = obb.cx + rx * sx + fx * sz;
      this.corners[o + 1] = obb.cy + hy * sy;
      this.corners[o + 2] = obb.cz + rz * sx + fz * sz;
    }

    // Determine which of the 6 local faces face the camera directly from local camera coordinates
    const faceVisible0 = localCamX > obb.hx;
    const faceVisible1 = localCamX < -obb.hx;
    const faceVisible2 = dy > obb.hy;
    const faceVisible3 = dy < -obb.hy;
    const faceVisible4 = localCamZ > obb.hz;
    const faceVisible5 = localCamZ < -obb.hz;

    let anyRasterized = false;
    if (faceVisible0 && this.rasterizeCornerQuad(0)) anyRasterized = true;
    if (faceVisible1 && this.rasterizeCornerQuad(1)) anyRasterized = true;
    if (faceVisible2 && this.rasterizeCornerQuad(2)) anyRasterized = true;
    if (faceVisible3 && this.rasterizeCornerQuad(3)) anyRasterized = true;
    if (faceVisible4 && this.rasterizeCornerQuad(4)) anyRasterized = true;
    if (faceVisible5 && this.rasterizeCornerQuad(5)) anyRasterized = true;

    if (anyRasterized) {
      this.occluderCount++;
    }
  }

  /**
   * Rasterizes an axis-aligned large opaque landmark hull (Dam wall, Port Warehouse,
   * Quarry Bunker, Railyard Depot) into the conservative depth buffer.
   */
  public addOccluderAabb(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    maxDistM = DEFAULT_LANDMARK_MAX_DIST_M,
  ): void {
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const hx = (maxX - minX) * 0.5;
    const hy = (maxY - minY) * 0.5;
    const hz = (maxZ - minZ) * 0.5;
    if (hy < MIN_OCCLUDER_HALF_HEIGHT_M || (hx < MIN_OCCLUDER_HALF_SPAN_M && hz < MIN_OCCLUDER_HALF_SPAN_M)) {
      return;
    }

    const dx = this.camX - cx;
    const dy = this.camY - cy;
    const dz = this.camZ - cz;
    const maxD = maxDistM + hx + hy + hz;
    if (dx * dx + dy * dy + dz * dz > maxD * maxD) return;

    if (
      Math.abs(dx) <= hx + 0.25 &&
      Math.abs(dy) <= hy + 0.25 &&
      Math.abs(dz) <= hz + 0.25
    ) {
      return;
    }

    for (let c = 0; c < 8; c++) {
      const o = c * 3;
      this.corners[o] = (c & 1) !== 0 ? maxX : minX;
      this.corners[o + 1] = (c & 2) !== 0 ? maxY : minY;
      this.corners[o + 2] = (c & 4) !== 0 ? maxZ : minZ;
    }

    let anyRasterized = false;
    if (dx > hx && this.rasterizeCornerQuad(0)) anyRasterized = true;
    if (dx < -hx && this.rasterizeCornerQuad(1)) anyRasterized = true;
    if (dy > hy && this.rasterizeCornerQuad(2)) anyRasterized = true;
    if (dy < -hy && this.rasterizeCornerQuad(3)) anyRasterized = true;
    if (dz > hz && this.rasterizeCornerQuad(4)) anyRasterized = true;
    if (dz < -hz && this.rasterizeCornerQuad(5)) anyRasterized = true;

    if (anyRasterized) {
      this.occluderCount++;
    }
  }

  /**
   * Builds the `8 × 5` coarse Hi-Z max-depth mip pyramid so large occluded bounding boxes
   * can be accepted as hidden in 1–4 array reads.
   */
  public finalizeOccluders(): void {
    let covered = 0;
    for (let cy = 0; cy < COARSE_H; cy++) {
      const pyStart = cy << COARSE_SHIFT;
      const pyEnd = Math.min(OCCL_HEIGHT, pyStart + 8);
      for (let cx = 0; cx < COARSE_W; cx++) {
        const pxStart = cx << COARSE_SHIFT;
        const pxEnd = Math.min(OCCL_WIDTH, pxStart + 8);
        let maxD = -1.0;
        for (let py = pyStart; py < pyEnd; py++) {
          const row = py * OCCL_WIDTH;
          for (let px = pxStart; px < pxEnd; px++) {
            const d = this.depthBuf[row + px];
            if (d < 0.9999) covered++;
            if (d > maxD) maxD = d;
          }
        }
        this.coarseMax[cy * COARSE_W + cx] = maxD;
      }
    }
    this.coveredPixelCount = covered;
    this.finalized = true;
  }

  /**
   * Conservative test: returns `true` ONLY when the entire screen-space footprint (expanded
   * by ±1 pixel) of `box` is strictly deeper than the rasterized occluder depth buffer.
   * Always returns `false` if the box is within `safetyRadiusM` of the camera or crosses the near plane.
   */
  public isBoxOccluded(box: THREE.Box3, safetyRadiusM = 12.0): boolean {
    if (!this.finalized || this.occluderCount === 0) return false;
    this.testedCount++;

    // Nearest point on AABB to camera for close safety halo
    const nearX = Math.max(box.min.x, Math.min(this.camX, box.max.x));
    const nearY = Math.max(box.min.y, Math.min(this.camY, box.max.y));
    const nearZ = Math.max(box.min.z, Math.min(this.camZ, box.max.z));
    const cdx = this.camX - nearX;
    const cdy = this.camY - nearY;
    const cdz = this.camZ - nearZ;
    if (cdx * cdx + cdy * cdy + cdz * cdz <= safetyRadiusM * safetyRadiusM) {
      return false;
    }

    const e = this.vpMatrix.elements;
    const e0 = e[0], e1 = e[1], e2 = e[2], e3 = e[3];
    const e4 = e[4], e5 = e[5], e6 = e[6], e7 = e[7];
    const e8 = e[8], e9 = e[9], e10 = e[10], e11 = e[11];
    const e12 = e[12], e13 = e[13], e14 = e[14], e15 = e[15];

    const minX = box.min.x, minY = box.min.y, minZ = box.min.z;
    const maxX = box.max.x, maxY = box.max.y, maxZ = box.max.z;
    const nearW = this.nearPlane;

    let minSx = Infinity;
    let maxSx = -Infinity;
    let minSy = Infinity;
    let maxSy = -Infinity;
    let minNdcZ = Infinity;

    for (let c = 0; c < 8; c++) {
      const vx = (c & 1) !== 0 ? maxX : minX;
      const vy = (c & 2) !== 0 ? maxY : minY;
      const vz = (c & 4) !== 0 ? maxZ : minZ;

      const cw = e3 * vx + e7 * vy + e11 * vz + e15;
      if (cw <= nearW) {
        // Box intersects or lies behind near plane: conservatively keep visible
        return false;
      }
      const invW = 1 / cw;
      const ndcX = (e0 * vx + e4 * vy + e8 * vz + e12) * invW;
      const ndcY = (e1 * vx + e5 * vy + e9 * vz + e13) * invW;
      const ndcZ = (e2 * vx + e6 * vy + e10 * vz + e14) * invW;

      const sx = (ndcX * 0.5 + 0.5) * OCCL_WIDTH;
      const sy = (ndcY * 0.5 + 0.5) * OCCL_HEIGHT;
      if (sx < minSx) minSx = sx;
      if (sx > maxSx) maxSx = sx;
      if (sy < minSy) minSy = sy;
      if (sy > maxSy) maxSy = sy;
      if (ndcZ < minNdcZ) minNdcZ = ndcZ;
    }

    // Off-screen targets are handled by frustum culling
    if (maxSx < 0 || minSx >= OCCL_WIDTH || maxSy < 0 || minSy >= OCCL_HEIGHT || minNdcZ <= -1.0) {
      return false;
    }

    // Expand target screen rect by 1 pixel outward for strict conservative accuracy
    const x0 = Math.max(0, Math.floor(minSx) - 1);
    const x1 = Math.min(OCCL_WIDTH - 1, Math.floor(maxSx) + 1);
    const y0 = Math.max(0, Math.floor(minSy) - 1);
    const y1 = Math.min(OCCL_HEIGHT - 1, Math.floor(maxSy) + 1);
    const testDepth = minNdcZ - DEPTH_BIAS;

    // 1. Coarse Hi-Z fast-accept across overlapping 8x8 blocks
    const cx0 = x0 >> COARSE_SHIFT;
    const cx1 = x1 >> COARSE_SHIFT;
    const cy0 = y0 >> COARSE_SHIFT;
    const cy1 = y1 >> COARSE_SHIFT;
    let allCoarseOccluded = true;
    for (let cy = cy0; cy <= cy1 && allCoarseOccluded; cy++) {
      const cRow = cy * COARSE_W;
      for (let cx = cx0; cx <= cx1; cx++) {
        if (this.coarseMax[cRow + cx] >= testDepth) {
          allCoarseOccluded = false;
          break;
        }
      }
    }
    if (allCoarseOccluded) {
      this.occludedCount++;
      return true;
    }

    // 2. Fine depth buffer check (any unoccluded pixel immediately exits visible)
    for (let py = y0; py <= y1; py++) {
      const row = py * OCCL_WIDTH;
      for (let px = x0; px <= x1; px++) {
        if (this.depthBuf[row + px] >= testDepth) {
          return false;
        }
      }
    }

    this.occludedCount++;
    return true;
  }

  /**
   * Conservative occlusion test for a bounding sphere (AI operators, wolves, deer).
   */
  public isSphereOccluded(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    safetyRadiusM = 14.0,
  ): boolean {
    if (!this.finalized || this.occluderCount === 0) return false;
    this.sphereBoxScratch.min.set(cx - radius, cy - radius, cz - radius);
    this.sphereBoxScratch.max.set(cx + radius, cy + radius, cz + radius);
    return this.isBoxOccluded(this.sphereBoxScratch, safetyRadiusM);
  }

  /**
   * Returns true ONLY when every single pixel of the 64×36 viewport is covered by a closer
   * solid occluder strictly nearer than `distanceM` (e.g., player indoors facing a solid wall).
   * Safe for hiding full-theater horizon skirts/water/forest belts with zero false positives.
   */
  public isScreenFullyOccludedBeyond(camera: THREE.PerspectiveCamera, distanceM: number): boolean {
    if (!this.finalized || this.occluderCount === 0 || this.coveredPixelCount < OCCL_PIXELS) {
      return false;
    }
    const n = camera.near;
    const f = camera.far;
    if (distanceM <= n || f <= n) return false;
    // Standard Three.js perspective NDC Z at view-space depth z = -distanceM:
    // ndcZ = (f + n) / (f - n) - (2 * f * n) / ((f - n) * distanceM)
    const targetNdcZ = (f + n) / (f - n) - (2 * f * n) / ((f - n) * distanceM);
    const threshold = targetNdcZ - DEPTH_BIAS;
    for (let i = 0; i < this.coarseMax.length; i++) {
      if (this.coarseMax[i] >= threshold) {
        return false;
      }
    }
    return true;
  }

  public getStats(): OcclusionCullerStats {
    return {
      occluderCount: this.occluderCount,
      rasterizedFaces: this.rasterizedFaces,
      testedCount: this.testedCount,
      occludedCount: this.occludedCount,
      coverageRatio: this.coveredPixelCount / OCCL_PIXELS,
    };
  }

  /**
   * Clips a 4-vertex face against the camera near plane (`w >= nearPlane`), projects it to
   * screen space, and writes conservative full-pixel depth coverage to `depthBuf`.
   */
  private rasterizeCornerQuad(faceIdx: number): boolean {
    const e = this.vpMatrix.elements;
    const e0 = e[0], e1 = e[1], e2 = e[2], e3 = e[3];
    const e4 = e[4], e5 = e[5], e6 = e[6], e7 = e[7];
    const e8 = e[8], e9 = e[9], e10 = e[10], e11 = e[11];
    const e12 = e[12], e13 = e[13], e14 = e[14], e15 = e[15];

    const fBase = faceIdx * 4;
    const nearW = this.nearPlane;

    // Transform 4 face corners into clip space & track frustum outcodes
    let allNegX = true;
    let allPosX = true;
    let allNegY = true;
    let allPosY = true;
    let allBehind = true;
    let allFar = true;

    for (let i = 0; i < 4; i++) {
      const ci = FACE_INDICES[fBase + i] * 3;
      const vx = this.corners[ci];
      const vy = this.corners[ci + 1];
      const vz = this.corners[ci + 2];

      const cx = e0 * vx + e4 * vy + e8 * vz + e12;
      const cy = e1 * vx + e5 * vy + e9 * vz + e13;
      const cz = e2 * vx + e6 * vy + e10 * vz + e14;
      const cw = e3 * vx + e7 * vy + e11 * vz + e15;

      this.inX[i] = cx;
      this.inY[i] = cy;
      this.inZ[i] = cz;
      this.inW[i] = cw;

      if (cw >= nearW) allBehind = false;
      if (cx >= -cw) allNegX = false;
      if (cx <= cw) allPosX = false;
      if (cy >= -cw) allNegY = false;
      if (cy <= cw) allPosY = false;
      if (cz <= cw) allFar = false;
    }

    if (allBehind || allNegX || allPosX || allNegY || allPosY || allFar) {
      return false;
    }

    // Sutherland-Hodgman clip quad against near plane (cw - nearW >= 0)
    let outCount = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) & 3;
      const d0 = this.inW[i] - nearW;
      const d1 = this.inW[j] - nearW;
      const in0 = d0 >= 0;
      const in1 = d1 >= 0;

      if (in0) {
        this.outX[outCount] = this.inX[i];
        this.outY[outCount] = this.inY[i];
        this.outZ[outCount] = this.inZ[i];
        this.outW[outCount] = this.inW[i];
        outCount++;
      }
      if (in0 !== in1) {
        const t = d0 / (d0 - d1);
        this.outX[outCount] = this.inX[i] + (this.inX[j] - this.inX[i]) * t;
        this.outY[outCount] = this.inY[i] + (this.inY[j] - this.inY[i]) * t;
        this.outZ[outCount] = this.inZ[i] + (this.inZ[j] - this.inZ[i]) * t;
        this.outW[outCount] = nearW;
        outCount++;
      }
    }

    if (outCount < 3) return false;

    // Project clipped polygon to screen space and compute screen AABB + depth range
    let minSx = Infinity;
    let maxSx = -Infinity;
    let minSy = Infinity;
    let maxSy = -Infinity;
    let polyMinZ = 1.0;
    let polyMaxZ = -1.0;

    for (let i = 0; i < outCount; i++) {
      const invW = 1 / this.outW[i];
      const sx = (this.outX[i] * invW * 0.5 + 0.5) * OCCL_WIDTH;
      const sy = (this.outY[i] * invW * 0.5 + 0.5) * OCCL_HEIGHT;
      const sz = Math.max(-1.0, Math.min(1.0, this.outZ[i] * invW));

      this.polySx[i] = sx;
      this.polySy[i] = sy;
      this.polySz[i] = sz;

      if (sx < minSx) minSx = sx;
      if (sx > maxSx) maxSx = sx;
      if (sy < minSy) minSy = sy;
      if (sy > maxSy) maxSy = sy;
      if (sz < polyMinZ) polyMinZ = sz;
      if (sz > polyMaxZ) polyMaxZ = sz;
    }

    const px0 = Math.max(0, Math.floor(minSx));
    const px1 = Math.min(OCCL_WIDTH - 1, Math.floor(maxSx));
    const py0 = Math.max(0, Math.floor(minSy));
    const py1 = Math.min(OCCL_HEIGHT - 1, Math.floor(maxSy));
    if (px0 > px1 || py0 > py1) return false;

    // Signed 2x area determines convex polygon winding in screen space
    let area2 = 0;
    for (let i = 0; i < outCount; i++) {
      const j = i + 1 === outCount ? 0 : i + 1;
      area2 += this.polySx[i] * this.polySy[j] - this.polySx[j] * this.polySy[i];
    }
    if (Math.abs(area2) < 1e-3) return false;
    const orient = area2 > 0 ? 1 : -1;

    // Solve exact affine screen-space depth plane z(x, y) = z0 + dzDx*(x-x0) + dzDy*(y-y0)
    // Pick triangle (0, k, k+1) with largest screen area for maximum numerical stability
    let bestDet = 0;
    let bestK = 1;
    const x0 = this.polySx[0];
    const y0 = this.polySy[0];
    const z0 = this.polySz[0];
    for (let k = 1; k < outCount - 1; k++) {
      const dx1 = this.polySx[k] - x0;
      const dy1 = this.polySy[k] - y0;
      const dx2 = this.polySx[k + 1] - x0;
      const dy2 = this.polySy[k + 1] - y0;
      const det = dx1 * dy2 - dx2 * dy1;
      if (Math.abs(det) > Math.abs(bestDet)) {
        bestDet = det;
        bestK = k;
      }
    }

    let dzDx = 0;
    let dzDy = 0;
    let usePlane = false;
    if (Math.abs(bestDet) > 1e-4) {
      const dx1 = this.polySx[bestK] - x0;
      const dy1 = this.polySy[bestK] - y0;
      const dz1 = this.polySz[bestK] - z0;
      const dx2 = this.polySx[bestK + 1] - x0;
      const dy2 = this.polySy[bestK + 1] - y0;
      const dz2 = this.polySz[bestK + 1] - z0;
      const invDet = 1 / bestDet;
      dzDx = (dz1 * dy2 - dz2 * dy1) * invDet;
      dzDy = (dx1 * dz2 - dx2 * dz1) * invDet;
      usePlane = Number.isFinite(dzDx) && Number.isFinite(dzDy);
    }

    // Conservative full-pixel rasterization: a pixel (px, py) is written ONLY when ALL 4 of
    // its corners lie inside every edge of the convex polygon, guaranteeing zero edge bleed
    // across open doorways, windows, or building corners.
    let wroteAny = false;
    for (let py = py0; py <= py1; py++) {
      const row = py * OCCL_WIDTH;
      for (let px = px0; px <= px1; px++) {
        let fullyInside = true;
        for (let eIdx = 0; eIdx < outCount; eIdx++) {
          const next = eIdx + 1 === outCount ? 0 : eIdx + 1;
          const ax = this.polySx[eIdx];
          const ay = this.polySy[eIdx];
          const ex = this.polySx[next] - ax;
          const ey = this.polySy[next] - ay;

          // Evaluate edge function at the single worst-case corner of [px, px+1] x [py, py+1]
          // Edge function f(x,y) = orient * (ex*(y - ay) - ey*(x - ax)) >= 0
          // Minimum over x in [px, px+1]: choose px+1 if (-orient*ey) < 0 else px
          // Minimum over y in [py, py+1]: choose py+1 if (orient*ex) < 0 else py
          const testX = orient * ey > 0 ? px + 1 : px;
          const testY = orient * ex < 0 ? py + 1 : py;
          const cross = orient * (ex * (testY - ay) - ey * (testX - ax));
          if (cross < 0) {
            fullyInside = false;
            break;
          }
        }
        if (!fullyInside) continue;

        let pixelDepth = polyMaxZ;
        if (usePlane) {
          // Conservative max (farthest) depth among the 4 corners of this pixel
          const maxXCorner = dzDx >= 0 ? px + 1 : px;
          const maxYCorner = dzDy >= 0 ? py + 1 : py;
          const dCorner = z0 + dzDx * (maxXCorner - x0) + dzDy * (maxYCorner - y0);
          pixelDepth = Math.max(polyMinZ, Math.min(polyMaxZ, dCorner));
        }

        const idx = row + px;
        if (pixelDepth < this.depthBuf[idx]) {
          this.depthBuf[idx] = pixelDepth;
        }
        wroteAny = true;
      }
    }

    if (wroteAny) {
      this.rasterizedFaces++;
    }
    return wroteAny;
  }
}

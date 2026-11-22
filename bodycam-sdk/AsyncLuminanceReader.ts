import * as THREE from 'three';

/**
 * Zero-stall double-buffered WebGL2 PBO (PIXEL_PACK_BUFFER + fenceSync) asynchronous luminance readback.
 *
 * Replaces synchronous `renderer.readRenderTargetPixels(...)` calls that force a full CPU<->GPU
 * pipeline flush every frame (a primary cause of random 40-180ms hitches under GPU load).
 *
 * - On WebGL2 hardware contexts: issues an async DMA `readPixels` into a PBO with `fenceSync`,
 *   then copies the completed bytes via `getBufferSubData` on a later frame ONLY once
 *   `gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED`. Never blocks the main thread.
 * - On WebGL1 or software WebGL fallback: throttles synchronous readback to every `fallbackIntervalFrames`
 *   frames to avoid unnecessary overhead.
 */
export class AsyncLuminanceReader {
  private readonly width: number;
  private readonly height: number;
  private readonly byteLength: number;
  private readonly weights: Float32Array;
  private readonly weightTotal: number;
  private readonly pixelBuf: Uint8Array;
  private readonly fallbackIntervalFrames: number;

  private initialized = false;
  private usePbo = false;
  private gl2: WebGL2RenderingContext | null = null;
  private pbos: Array<WebGLBuffer | null> = [null, null];
  private syncs: Array<WebGLSync | null> = [null, null];
  private pending: [boolean, boolean] = [false, false];
  private writeSlot = 0;
  private frameCounter = 0;

  constructor(
    width: number,
    height: number,
    centerBiasBase: number,
    centerBiasSlope: number,
    minWeight: number,
    fallbackIntervalFrames = 8,
  ) {
    this.width = width;
    this.height = height;
    this.byteLength = width * height * 4;
    this.pixelBuf = new Uint8Array(this.byteLength);
    this.weights = new Float32Array(width * height);
    this.fallbackIntervalFrames = Math.max(1, fallbackIntervalFrames);

    // Precompute center-weighting table once (zero Math.hypot calls per frame)
    let sum = 0;
    for (let y = 0; y < height; y++) {
      const dy = (y + 0.5) / height - 0.5;
      for (let x = 0; x < width; x++) {
        const dx = (x + 0.5) / width - 0.5;
        const w = Math.max(minWeight, centerBiasBase - Math.hypot(dx, dy) * centerBiasSlope);
        this.weights[y * width + x] = w;
        sum += w;
      }
    }
    this.weightTotal = Math.max(0.001, sum);
  }

  private ensureInit(renderer: THREE.WebGLRenderer, isSoftwareGl: boolean): void {
    if (this.initialized) return;
    this.initialized = true;

    if (isSoftwareGl || !renderer.capabilities.isWebGL2) {
      this.usePbo = false;
      return;
    }

    const rawGl = renderer.getContext();
    if (
      typeof WebGL2RenderingContext !== 'undefined' &&
      rawGl instanceof WebGL2RenderingContext &&
      typeof rawGl.fenceSync === 'function' &&
      typeof rawGl.getBufferSubData === 'function'
    ) {
      const pbo0 = rawGl.createBuffer();
      const pbo1 = rawGl.createBuffer();
      if (pbo0 && pbo1) {
        rawGl.bindBuffer(rawGl.PIXEL_PACK_BUFFER, pbo0);
        rawGl.bufferData(rawGl.PIXEL_PACK_BUFFER, this.byteLength, rawGl.STREAM_READ);
        rawGl.bindBuffer(rawGl.PIXEL_PACK_BUFFER, pbo1);
        rawGl.bufferData(rawGl.PIXEL_PACK_BUFFER, this.byteLength, rawGl.STREAM_READ);
        rawGl.bindBuffer(rawGl.PIXEL_PACK_BUFFER, null);

        this.gl2 = rawGl;
        this.pbos = [pbo0, pbo1];
        this.usePbo = true;
      } else {
        if (pbo0) rawGl.deleteBuffer(pbo0);
        if (pbo1) rawGl.deleteBuffer(pbo1);
      }
    }
  }

  private computeAverageLuminance(): number {
    let weightedLogSum = 0;
    const count = this.width * this.height;
    const buf = this.pixelBuf;
    const weights = this.weights;
    for (let i = 0; i < count; i++) {
      const encoded = buf[i * 4] / 255.0;
      const logLuma = encoded * 12.0 - 6.0;
      weightedLogSum += logLuma * weights[i];
    }
    return Math.pow(2, weightedLogSum / this.weightTotal);
  }

  /**
   * Non-blocking poll + enqueue step.
   * Call immediately AFTER rendering the luminance downsample pass into `lumTarget`.
   * Returns a newly measured average luminance when a frame's readback finishes, or `null`
   * if the previous luminance value should be kept for this frame (zero stall).
   */
  public step(
    renderer: THREE.WebGLRenderer,
    lumTarget: THREE.WebGLRenderTarget,
    isSoftwareGl: boolean,
  ): number | null {
    this.ensureInit(renderer, isSoftwareGl);
    this.frameCounter++;

    // Fallback path (WebGL1 or software WebGL): low-frequency throttled readback
    if (!this.usePbo || !this.gl2) {
      if (this.frameCounter % this.fallbackIntervalFrames !== 0) {
        return null;
      }
      renderer.readRenderTargetPixels(
        lumTarget,
        0,
        0,
        this.width,
        this.height,
        this.pixelBuf,
      );
      return this.computeAverageLuminance();
    }

    const gl = this.gl2;
    let measuredLuminance: number | null = null;

    // 1. Poll any pending PBO slots without blocking. If GPU signaled completion, copy bytes out.
    for (let i = 0; i < 2; i++) {
      if (!this.pending[i]) continue;
      const sync = this.syncs[i];
      if (!sync) {
        this.pending[i] = false;
        continue;
      }

      const status = gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (status === gl.SIGNALED) {
        gl.deleteSync(sync);
        this.syncs[i] = null;
        this.pending[i] = false;

        const pbo = this.pbos[i];
        if (pbo) {
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.pixelBuf);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          measuredLuminance = this.computeAverageLuminance();
        }
      }
    }

    // 2. Enqueue a new async DMA read every 2nd frame into a free PBO slot
    if (this.frameCounter % 2 === 0) {
      const slot = this.writeSlot;
      if (!this.pending[slot] && this.pbos[slot]) {
        // Ensure lumTarget framebuffer is currently bound before issuing async readPixels
        renderer.setRenderTarget(lumTarget);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbos[slot]);
        gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (sync) {
          gl.flush();
          this.syncs[slot] = sync;
          this.pending[slot] = true;
          this.writeSlot = 1 - slot;
        }
      }
    }

    return measuredLuminance;
  }

  public dispose(): void {
    const gl = this.gl2;
    if (gl) {
      for (let i = 0; i < 2; i++) {
        if (this.syncs[i]) {
          gl.deleteSync(this.syncs[i]!);
          this.syncs[i] = null;
        }
        if (this.pbos[i]) {
          gl.deleteBuffer(this.pbos[i]!);
          this.pbos[i] = null;
        }
        this.pending[i] = false;
      }
    }
    this.gl2 = null;
    this.usePbo = false;
    this.initialized = false;
  }
}

import { CHUNK_SIZE } from './RoadNetwork';
import type { BoxCollider } from './WorldBuilder';

export function makeChunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

export function worldToChunkCoord(val: number): number {
  return Math.floor(val / CHUNK_SIZE);
}

/**
 * Spatial collider index keyed by chunkKey ("cx,cz").
 * All stored AABBs are in deterministic True World Coordinates so floating-origin
 * rebasing never corrupts static collision bounds.
 */
export class WorldColliderIndex {
  private byChunk = new Map<string, BoxCollider[]>();

  public registerChunk(chunkKey: string, colliders: BoxCollider[]): void {
    this.byChunk.set(chunkKey, colliders);
  }

  public unregisterChunk(chunkKey: string): void {
    this.byChunk.delete(chunkKey);
  }

  public removeCollider(chunkKey: string, colliderId: string): boolean {
    const list = this.byChunk.get(chunkKey);
    if (!list) return false;
    const idx = list.findIndex((c) => c.id === colliderId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    return true;
  }

  public updateColliderXZ(
    chunkKey: string,
    colliderId: string,
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
  ): void {
    const list = this.byChunk.get(chunkKey);
    if (!list) return;
    const c = list.find((item) => item.id === colliderId);
    if (!c) return;
    c.minX = minX;
    c.maxX = maxX;
    c.minZ = minZ;
    c.maxZ = maxZ;
  }

  /**
   * Populates `out` with local-scene-space colliders (shifted by -originX, -originZ)
   * strictly from chunks within `chunkRadius` of `(worldX, worldZ)`.
   */
  public writeLocalCollidersNear(
    worldX: number,
    worldZ: number,
    originX: number,
    originZ: number,
    chunkRadius: number,
    out: BoxCollider[],
  ): void {
    const pcx = worldToChunkCoord(worldX);
    const pcz = worldToChunkCoord(worldZ);
    let writeIdx = 0;

    for (let dx = -chunkRadius; dx <= chunkRadius; dx++) {
      for (let dz = -chunkRadius; dz <= chunkRadius; dz++) {
        const list = this.byChunk.get(makeChunkKey(pcx + dx, pcz + dz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const src = list[i];
          if (writeIdx < out.length) {
            const dst = out[writeIdx];
            dst.id = src.id;
            dst.minX = src.minX - originX;
            dst.maxX = src.maxX - originX;
            dst.minY = src.minY;
            dst.maxY = src.maxY;
            dst.minZ = src.minZ - originZ;
            dst.maxZ = src.maxZ - originZ;
            dst.surface = src.surface;
            dst.penetrableWood = src.penetrableWood;
            dst.blocksMovement = src.blocksMovement;
            dst.blocksVision = src.blocksVision;
          } else {
            out.push({
              id: src.id,
              minX: src.minX - originX,
              maxX: src.maxX - originX,
              minY: src.minY,
              maxY: src.maxY,
              minZ: src.minZ - originZ,
              maxZ: src.maxZ - originZ,
              surface: src.surface,
              penetrableWood: src.penetrableWood,
              blocksMovement: src.blocksMovement,
              blocksVision: src.blocksVision,
            });
          }
          writeIdx++;
        }
      }
    }
    out.length = writeIdx;
  }

  public clear(): void {
    this.byChunk.clear();
  }
}

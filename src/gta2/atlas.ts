import { Sty, TILE_SIZE } from './sty';

/**
 * Packs all STY tiles into one RGBA atlas (32x32 tiles = 2048x2048 for the
 * standard 992-tile styles). Pure data — the renderer uploads it as a texture.
 */
export const ATLAS_TILES_PER_ROW = 32;

export interface TileAtlas {
  size: number; // pixels, square
  data: Uint8Array; // RGBA
  /** uv rect of tile t: [u0, v0, u1, v1] (v measured with image top = 0) */
  uv(tile: number): [number, number, number, number];
}

export function buildTileAtlas(sty: Sty): TileAtlas {
  const n = sty.tileCount;
  const size = ATLAS_TILES_PER_ROW * TILE_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let t = 0; t < n; t++) {
    const rgba = sty.tileRGBA(t);
    const ax = (t % ATLAS_TILES_PER_ROW) * TILE_SIZE;
    const ay = Math.floor(t / ATLAS_TILES_PER_ROW) * TILE_SIZE;
    for (let y = 0; y < TILE_SIZE; y++) {
      const src = y * TILE_SIZE * 4;
      const dst = ((ay + y) * size + ax) * 4;
      data.set(rgba.subarray(src, src + TILE_SIZE * 4), dst);
    }
  }
  const px = 1 / size;
  return {
    size,
    data,
    uv(tile: number) {
      const ax = (tile % ATLAS_TILES_PER_ROW) * TILE_SIZE;
      const ay = Math.floor(tile / ATLAS_TILES_PER_ROW) * TILE_SIZE;
      // Inset by half a texel to avoid bleeding between atlas neighbours.
      return [
        (ax + 0.5) * px,
        (ay + 0.5) * px,
        (ax + TILE_SIZE - 0.5) * px,
        (ay + TILE_SIZE - 0.5) * px,
      ];
    },
  };
}

import { Sty, TILE_SIZE } from './sty';
import type { TileAnimation } from './gmp';

/**
 * Packs all STY tiles into one RGBA atlas (32x32 tiles = 2048x2048 for the
 * standard 992-tile styles). Pure data — the renderer uploads it as a texture.
 *
 * Animated tiles (GMP ANIM chunk): each animation's base tile gets its own
 * atlas slot — virtual bases (>= tileCount) are assigned to the spare slots
 * past the style's tiles. The renderer re-blits those slots as frames advance
 * so every face using the tile animates at once, exactly like the original's
 * tile cycling.
 */
export const ATLAS_TILES_PER_ROW = 32;

export interface TileAtlas {
  size: number; // pixels, square
  data: Uint8Array; // RGBA
  /** uv rect of tile t: [u0, v0, u1, v1] (v measured with image top = 0) */
  uv(tile: number): [number, number, number, number];
  /** atlas slot (pixel x/y) that a tile renders from, after anim mapping */
  slotXY(tile: number): [number, number];
  /** true if the tile resolves to an atlas slot (virtual bases need ANIM) */
  has(tile: number): boolean;
}

export function buildTileAtlas(sty: Sty, animations: TileAnimation[] = []): TileAtlas {
  const n = sty.tileCount;
  const size = ATLAS_TILES_PER_ROW * TILE_SIZE;
  const slots = ATLAS_TILES_PER_ROW * ATLAS_TILES_PER_ROW;
  const data = new Uint8Array(size * size * 4);

  const blit = (slot: number, tile: number) => {
    const rgba = sty.tileRGBA(tile);
    const ax = (slot % ATLAS_TILES_PER_ROW) * TILE_SIZE;
    const ay = Math.floor(slot / ATLAS_TILES_PER_ROW) * TILE_SIZE;
    for (let y = 0; y < TILE_SIZE; y++) {
      const src = y * TILE_SIZE * 4;
      const dst = ((ay + y) * size + ax) * 4;
      data.set(rgba.subarray(src, src + TILE_SIZE * 4), dst);
    }
  };

  for (let t = 0; t < n; t++) blit(t, t);

  // Animation bases: real-tile bases keep their slot; virtual bases get the
  // spare slots above tileCount. Seed each with the animation's first frame.
  const slotOf = new Map<number, number>();
  let nextFree = n;
  for (const a of animations) {
    if (a.tiles.length === 0) continue;
    if (a.base < n) {
      slotOf.set(a.base, a.base);
    } else if (nextFree < slots) {
      slotOf.set(a.base, nextFree);
      blit(nextFree, a.tiles[0] < n ? a.tiles[0] : 0);
      nextFree++;
    }
  }

  const px = 1 / size;
  const slotXY = (tile: number): [number, number] => {
    const slot = slotOf.get(tile) ?? (tile < n ? tile : 0);
    return [
      (slot % ATLAS_TILES_PER_ROW) * TILE_SIZE,
      Math.floor(slot / ATLAS_TILES_PER_ROW) * TILE_SIZE,
    ];
  };
  return {
    size,
    data,
    slotXY,
    has(tile: number) {
      return tile < n || slotOf.has(tile);
    },
    uv(tile: number) {
      const [ax, ay] = slotXY(tile);
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

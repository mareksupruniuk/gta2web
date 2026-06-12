import { decodeLid, decodeSide, Face, GmpMap, lidLightingLevel, MAP_SIZE, slopeType } from './gmp';
import { isDiagonal, slopeCorners } from './slopes';
import { Sty, TILE_SIZE } from './sty';
import { TileAtlas } from './atlas';

/**
 * Converts the block map into renderable triangle soup, chunk by chunk.
 * Pure data (no three.js) so it can be unit-tested in node.
 */

export const CHUNK = 16; // blocks per chunk side

export interface GeomArrays {
  positions: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
}

export interface ChunkGeometry {
  cx: number;
  cy: number;
  solid: GeomArrays;
  cutout: GeomArrays; // faces needing alpha-test (transparent texels / flat overlays)
}

const LID_SHADE = [1.0, 0.8, 0.62, 0.45]; // lid lighting levels 0-3
const WALL_SHADE_X = 0.8; // west/east walls
const WALL_SHADE_Y = 0.9; // north/south walls

type V3 = [number, number, number];

function emptyGeom(): GeomArrays {
  return { positions: [], uvs: [], colors: [], indices: [] };
}

// Map y grows south; render space uses y-north so the world isn't mirrored
// on screen. The flip happens here, at the single point vertices are emitted.
function pushQuad(g: GeomArrays, v: [V3, V3, V3, V3], uv: [number, number][], shade: number): void {
  const base = g.positions.length / 3;
  for (let i = 0; i < 4; i++) {
    g.positions.push(v[i][0], -v[i][1], v[i][2]);
    g.uvs.push(uv[i][0], uv[i][1]);
    g.colors.push(shade, shade, shade);
  }
  g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function pushTri(g: GeomArrays, v: [V3, V3, V3], uv: [number, number][], shade: number): void {
  const base = g.positions.length / 3;
  for (let i = 0; i < 3; i++) {
    g.positions.push(v[i][0], -v[i][1], v[i][2]);
    g.uvs.push(uv[i][0], uv[i][1]);
    g.colors.push(shade, shade, shade);
  }
  g.indices.push(base, base + 1, base + 2);
}

/**
 * uv corners [nw, ne, se, sw] for a face, honouring rotation + flip bits.
 * Each rotation step turns the tile 90° clockwise, then flip mirrors the
 * result left-right. Both the direction and the rotate-then-flip order are
 * matched against the original game's UV code (gta2_re MapRenderer
 * sub_46B910: rot1 = (u,v)→(v,64-u), rot1+flip = (u,v)→(v,u)).
 */
function faceUV(atlas: TileAtlas, f: Face): [number, number][] {
  const [u0, v0, u1, v1] = atlas.uv(f.tile);
  let c: [number, number][] = [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ];
  for (let r = 0; r < f.rotation; r++) c = [c[3], c[0], c[1], c[2]];
  if (f.flip) c = [c[1], c[0], c[3], c[2]];
  return c;
}

/** Precompute which tiles contain transparent texels (palette index 0). */
export function computeTransparentTiles(sty: Sty): Set<number> {
  const out = new Set<number>();
  for (let t = 0; t < sty.tileCount; t++) {
    scan: for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        if (sty.tilePixel(t, x, y) === 0) {
          out.add(t);
          break scan;
        }
      }
    }
  }
  return out;
}

export function buildChunkGeometry(
  map: GmpMap,
  atlas: TileAtlas,
  transparent: Set<number>,
  cx: number,
  cy: number,
): ChunkGeometry {
  const solid = emptyGeom();
  const cutout = emptyGeom();
  const pick = (f: Face) => (f.flat || transparent.has(f.tile) ? cutout : solid);

  // Animated tiles keep their own atlas slot (the renderer cycles the slot's
  // pixels through the ANIM frames, so every face using it animates at once).
  // Virtual tiles without an ANIM entry are invisible in the original — they
  // fall back to tile 0 here.
  const fix = (f: Face): Face => (atlas.has(f.tile) ? f : { ...f, tile: 0 });

  for (let by = cy * CHUNK; by < (cy + 1) * CHUNK; by++) {
    for (let bx = cx * CHUNK; bx < (cx + 1) * CHUNK; bx++) {
      if (bx >= MAP_SIZE || by >= MAP_SIZE) continue;
      const col = map.getColumn(bx, by);
      for (let i = 0; i < col.blockIds.length; i++) {
        const z = col.offset + i;
        const b = map.blocks[col.blockIds[i]];
        if (!b) continue;
        const slope = slopeType(b);
        const c = slopeCorners(slope);
        const lid = fix(decodeLid(b.lid));
        // "flipping and rotation is not supported on the sides of slopes"
        const isSlope = slope >= 1 && slope <= 44;
        const sideFix = (v: number): Face => {
          const f = fix(decodeSide(v));
          return isSlope ? { ...f, rotation: 0, flip: false } : f;
        };
        const left = sideFix(b.left);
        const right = sideFix(b.right);
        const top = sideFix(b.top);
        const bottom = sideFix(b.bottom);
        const zNW = z + c.nw;
        const zNE = z + c.ne;
        const zSW = z + c.sw;
        const zSE = z + c.se;

        if (lid.tile !== 0) {
          const shade = LID_SHADE[lidLightingLevel(b.lid)];
          const uv = faceUV(atlas, lid);
          if (isDiagonal(slope)) {
            // lid is a triangle; the cut corner depends on facing
            const facing = slope - 45; // 0 ul, 1 ur, 2 dl, 3 dr
            const corners: [V3, V3, V3, V3] = [
              [bx, by, zNW],
              [bx + 1, by, zNE],
              [bx + 1, by + 1, zSE],
              [bx, by + 1, zSW],
            ];
            const cut = [0, 1, 3, 2][facing]; // nw, ne, sw, se
            const tri = [0, 1, 2, 3].filter((k) => k !== cut);
            pushTri(
              pick(lid),
              [corners[tri[0]], corners[tri[1]], corners[tri[2]]],
              [uv[tri[0]], uv[tri[1]], uv[tri[2]]],
              shade,
            );
          } else {
            pushQuad(
              pick(lid),
              [
                [bx, by, zNW],
                [bx + 1, by, zNE],
                [bx + 1, by + 1, zSE],
                [bx, by + 1, zSW],
              ],
              uv,
              shade,
            );
          }
        }

        if (isDiagonal(slope)) {
          // Diagonal wall across the cut corner; tile comes from the side
          // fields (left for *-left facings, right for *-right facings).
          const facing = slope - 45;
          const f = facing === 0 || facing === 2 ? left : right;
          if (f.tile !== 0) {
            const uv = faceUV(atlas, f);
            const [a, bb]: [V3, V3] =
              facing === 0 ? [[bx + 1, by, zNE], [bx, by + 1, zSW]] :
              facing === 1 ? [[bx + 1, by + 1, zSE], [bx, by, zNW]] :
              facing === 2 ? [[bx, by, zNW], [bx + 1, by + 1, zSE]] :
              [[bx, by + 1, zSW], [bx + 1, by, zNE]];
            pushQuad(
              pick(f),
              [a, bb, [bb[0], bb[1], z], [a[0], a[1], z]],
              [uv[0], uv[1], uv[2], uv[3]],
              0.85,
            );
          }
        } else {
          if (left.tile !== 0) {
            const uv = faceUV(atlas, left);
            pushQuad(
              pick(left),
              [
                [bx, by, zNW],
                [bx, by + 1, zSW],
                [bx, by + 1, z],
                [bx, by, z],
              ],
              uv,
              WALL_SHADE_X,
            );
          }
          if (right.tile !== 0) {
            const uv = faceUV(atlas, right);
            pushQuad(
              pick(right),
              [
                [bx + 1, by + 1, zSE],
                [bx + 1, by, zNE],
                [bx + 1, by, z],
                [bx + 1, by + 1, z],
              ],
              uv,
              WALL_SHADE_X,
            );
          }
          if (top.tile !== 0) {
            const uv = faceUV(atlas, top);
            pushQuad(
              pick(top),
              [
                [bx + 1, by, zNE],
                [bx, by, zNW],
                [bx, by, z],
                [bx + 1, by, z],
              ],
              uv,
              WALL_SHADE_Y,
            );
          }
          if (bottom.tile !== 0) {
            const uv = faceUV(atlas, bottom);
            pushQuad(
              pick(bottom),
              [
                [bx, by + 1, zSW],
                [bx + 1, by + 1, zSE],
                [bx + 1, by + 1, z],
                [bx, by + 1, z],
              ],
              uv,
              WALL_SHADE_Y,
            );
          }
        }
      }
    }
  }
  return { cx, cy, solid, cutout };
}

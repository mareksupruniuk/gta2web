/**
 * GTA2 slope geometry. slope_type (block_info.slopeByte >> 2) values:
 *   0        flat
 *   1-2      up 26°  (2 pieces: low, high)
 *   3-4      down 26°
 *   5-6      left 26°
 *   7-8      right 26°
 *   9-16     up 7°   (8 pieces)
 *   17-24    down 7°
 *   25-32    left 7°
 *   33-40    right 7°
 *   41-44    up/down/left/right 45° (1 piece)
 *   45-48    diagonal corner cuts (facing up-left/up-right/down-left/down-right)
 *   49-60    partial blocks
 *   61       partial centre block
 *   63       solid flat (indestructible)
 *
 * Map coordinates: x grows east, y grows south. "up" slopes rise toward
 * north (-y), "left" toward west (-x).
 */

export interface SlopeCorners {
  /** lid height fractions (0..1 of one block) at the four lid corners */
  nw: number;
  ne: number;
  sw: number;
  se: number;
}

const FLAT: SlopeCorners = { nw: 1, ne: 1, sw: 1, se: 1 };

function dirSlope(dir: 'up' | 'down' | 'left' | 'right', lo: number, hi: number): SlopeCorners {
  switch (dir) {
    case 'up': return { nw: hi, ne: hi, sw: lo, se: lo };
    case 'down': return { nw: lo, ne: lo, sw: hi, se: hi };
    case 'left': return { nw: hi, ne: lo, sw: hi, se: lo };
    case 'right': return { nw: lo, ne: hi, sw: lo, se: hi };
  }
}

export function slopeCorners(slope: number): SlopeCorners {
  if (slope === 0 || slope >= 45) return FLAT;
  if (slope <= 8) {
    // 26° two-piece slopes
    const dir = (['up', 'up', 'down', 'down', 'left', 'left', 'right', 'right'] as const)[slope - 1];
    const piece = (slope - 1) % 2; // 0 = low half, 1 = high half
    return dirSlope(dir, piece / 2, (piece + 1) / 2);
  }
  if (slope <= 40) {
    // 7° eight-piece slopes
    const idx = slope - 9;
    const dir = (['up', 'down', 'left', 'right'] as const)[Math.floor(idx / 8)];
    const piece = idx % 8;
    return dirSlope(dir, piece / 8, (piece + 1) / 8);
  }
  // 41-44: 45° full-block slopes
  const dir = (['up', 'down', 'left', 'right'] as const)[slope - 41];
  return dirSlope(dir, 0, 1);
}

/** True for diagonal corner blocks (45-48) whose lid is a triangle. */
export function isDiagonal(slope: number): boolean {
  return slope >= 45 && slope <= 48;
}

/**
 * Lid height fraction at local position (fx, fy) in [0,1]² within the block,
 * bilinearly interpolated from the corner heights.
 */
export function slopeHeightAt(slope: number, fx: number, fy: number): number {
  const c = slopeCorners(slope);
  const top = c.nw + (c.ne - c.nw) * fx;
  const bot = c.sw + (c.se - c.sw) * fx;
  return top + (bot - top) * fy;
}

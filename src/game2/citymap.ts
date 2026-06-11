import { BlockInfo, decodeLid, decodeSide, GmpMap, groundType, GroundType, MAP_SIZE, MapZone, slopeType, ZoneType } from '../gta2/gmp';
import { slopeHeightAt } from '../gta2/slopes';

/**
 * Gameplay view of the parsed GTA2 map: ground heights (bridge-aware),
 * wall collision, ground types and the green-arrow traffic network.
 * World units: 1 block = 1.0; z grows upward.
 */

export interface ArrowDirs {
  west: boolean;
  east: boolean;
  north: boolean;
  south: boolean;
}

export class CityMap {
  constructor(readonly gmp: GmpMap) {}

  /**
   * Walking/driving surface height at (x, y): the highest lid surface that
   * is at or below zHint (+ small epsilon). Surfaces above zHint — bridge
   * decks, elevated roads — are ignored, so entities can pass underneath.
   * Returns null over void (no surface at or below).
   */
  groundZ(x: number, y: number, zHint: number): number | null {
    const bx = Math.floor(x);
    const by = Math.floor(y);
    if (bx < 0 || by < 0 || bx >= MAP_SIZE || by >= MAP_SIZE) return null;
    const fx = x - bx;
    const fy = y - by;
    const maxLevel = Math.min(7, Math.floor(zHint + 0.05));
    for (let lvl = maxLevel; lvl >= 0; lvl--) {
      const b = this.gmp.getBlock(bx, by, lvl);
      if (!b) continue;
      if (decodeLid(b.lid).tile === 0) continue;
      const slope = slopeType(b);
      if (slope === 63) continue; // marker: real slope is the block above
      const surface = lvl + slopeHeightAt(slope, fx, fy);
      if (surface <= zHint + 0.05) return surface;
    }
    return null;
  }

  blockAtFoot(x: number, y: number, z: number): BlockInfo | null {
    // the block we stand on has its lid near z → block level just below
    const lvl = Math.max(0, Math.round(z) - 1);
    return this.gmp.getBlock(Math.floor(x), Math.floor(y), lvl);
  }

  groundTypeAt(x: number, y: number, z: number): GroundType {
    const b = this.blockAtFoot(x, y, z);
    return b ? groundType(b) : GroundType.Air;
  }

  /**
   * Can a body at height z move from (x0,y0) to (x1,y1)? Checks the wall
   * flags of every block boundary crossed (at body level) and refuses steps
   * higher than `maxStep`.
   */
  canMove(x0: number, y0: number, x1: number, y1: number, z: number, maxStep = 0.55): boolean {
    const lvl = Math.max(0, Math.min(7, Math.floor(z + 0.05)));
    let bx = Math.floor(x0);
    let by = Math.floor(y0);
    const tx = Math.floor(x1);
    const ty = Math.floor(y1);

    // step across boundaries one axis at a time (paths are short per tick)
    let guard = 8;
    while ((bx !== tx || by !== ty) && guard-- > 0) {
      const sx = Math.sign(tx - bx);
      const sy = Math.sign(ty - by);
      if (sx !== 0) {
        if (this.wallBetweenX(bx, by, sx, lvl)) return false;
        bx += sx;
      }
      if (sy !== 0) {
        if (this.wallBetweenY(bx, by, sy, lvl)) return false;
        by += sy;
      }
    }

    const g0 = this.groundZ(x0, y0, z);
    const g1 = this.groundZ(x1, y1, z + maxStep);
    if (g1 === null) return false; // void
    if (g0 !== null && g1 - z > maxStep) return false; // too tall a step
    return true;
  }

  /**
   * Radius-aware variant of canMove for bodies (player/peds): the centre and
   * the four edge points of the body circle must all be able to make the move.
   */
  canMoveBody(x0: number, y0: number, x1: number, y1: number, z: number, r: number, maxStep = 0.55): boolean {
    for (const [ox, oy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]] as const) {
      if (!this.canMove(x0 + ox, y0 + oy, x1 + ox, y1 + oy, z, maxStep)) return false;
    }
    return true;
  }

  /** wall when crossing from column (bx,by) to (bx+sx,by) at level lvl */
  private wallBetweenX(bx: number, by: number, sx: number, lvl: number): boolean {
    const here = this.gmp.getBlock(bx, by, lvl);
    const there = this.gmp.getBlock(bx + sx, by, lvl);
    if (sx > 0) {
      if (here && decodeSide(here.right).wall) return true;
      if (there && decodeSide(there.left).wall) return true;
    } else {
      if (here && decodeSide(here.left).wall) return true;
      if (there && decodeSide(there.right).wall) return true;
    }
    return false;
  }

  private wallBetweenY(bx: number, by: number, sy: number, lvl: number): boolean {
    const here = this.gmp.getBlock(bx, by, lvl);
    const there = this.gmp.getBlock(bx, by + sy, lvl);
    if (sy > 0) {
      if (here && decodeSide(here.bottom).wall) return true;
      if (there && decodeSide(there.top).wall) return true;
    } else {
      if (here && decodeSide(here.top).wall) return true;
      if (there && decodeSide(there.bottom).wall) return true;
    }
    return false;
  }

  /** Green traffic arrows of the block stood on at (x, y, z). */
  arrowsAt(x: number, y: number, z: number): ArrowDirs {
    const b = this.blockAtFoot(x, y, z);
    const a = b ? b.arrows : 0;
    return {
      west: (a & 1) !== 0,
      east: (a & 2) !== 0,
      north: (a & 4) !== 0,
      south: (a & 8) !== 0,
    };
  }

  zonesOfType(type: ZoneType): MapZone[] {
    return this.gmp.zones.filter((z) => z.type === type);
  }

  /** Navigation zone name containing (x, y) — smallest area wins. */
  areaName(x: number, y: number): string | null {
    let best: MapZone | null = null;
    for (const z of this.gmp.zones) {
      if (z.type !== ZoneType.Navigation && z.type !== ZoneType.LocalNavigation) continue;
      if (x < z.x || y < z.y || x >= z.x + z.w || y >= z.y + z.h) continue;
      if (!best || z.w * z.h < best.w * best.h) best = z;
    }
    return best?.name ?? null;
  }

  /** Police station drop-off (busted respawn): first 'policestation*' zone. */
  policeStation(): { x: number; y: number; z: number } | null {
    const z = this.gmp.zones.find(
      (zn) => zn.type === ZoneType.Information && zn.name.toLowerCase().startsWith('policestation'),
    );
    if (!z) return null;
    const x = z.x + z.w / 2;
    const y = z.y + z.h / 2;
    const gz = this.groundZ(x, y, 7.9);
    return gz !== null ? { x, y, z: gz } : null;
  }

  /** Player spawn: centre of a restart zone (fallback: map centre). */
  playerSpawn(): { x: number; y: number; z: number } {
    const restarts = this.zonesOfType(ZoneType.Restart);
    const r = restarts[0];
    const x = r ? r.x + r.w / 2 : MAP_SIZE / 2;
    const y = r ? r.y + r.h / 2 : MAP_SIZE / 2;
    const z = this.groundZ(x, y, 7.9) ?? 2;
    return { x, y, z };
  }

  /**
   * Scan for blocks usable as spawn points. Returns block centres with
   * ground info; sampled across the whole map.
   */
  scanSpawns(): { roads: { x: number; y: number; z: number; arrows: ArrowDirs }[]; pavements: { x: number; y: number; z: number }[] } {
    const roads: { x: number; y: number; z: number; arrows: ArrowDirs }[] = [];
    const pavements: { x: number; y: number; z: number }[] = [];
    for (let by = 0; by < MAP_SIZE; by++) {
      for (let bx = 0; bx < MAP_SIZE; bx++) {
        const col = this.gmp.getColumn(bx, by);
        for (let i = col.blockIds.length - 1; i >= 0; i--) {
          const lvl = col.offset + i;
          const b = this.gmp.blocks[col.blockIds[i]];
          if (!b || decodeLid(b.lid).tile === 0) continue;
          const g = groundType(b);
          const x = bx + 0.5;
          const y = by + 0.5;
          const z = lvl + slopeHeightAt(slopeType(b) === 63 ? 0 : slopeType(b), 0.5, 0.5);
          if (g === GroundType.Road && b.arrows !== 0) {
            roads.push({ x, y, z, arrows: this.arrowsAt(x, y, z) });
          } else if (g === GroundType.Pavement) {
            pavements.push({ x, y, z });
          }
          break; // top surface only
        }
      }
    }
    return { roads, pavements };
  }
}

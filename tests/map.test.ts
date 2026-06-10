import { describe, expect, it } from 'vitest';
import { flowDirs, generateDowntown } from '../src/sim/map';
import { Dir, TILE, Tile } from '../src/sim/types';

describe('generateDowntown', () => {
  it('is deterministic for the same seed', () => {
    const a = generateDowntown(1234);
    const b = generateDowntown(1234);
    expect(Array.from(a.tiles)).toEqual(Array.from(b.tiles));
    expect(Array.from(a.flows)).toEqual(Array.from(b.flows));
    expect(a.playerSpawn).toEqual(b.playerSpawn);
    expect(a.carSpawns).toEqual(b.carSpawns);
    expect(a.pickups).toEqual(b.pickups);
    expect(a.pedSpawnTiles).toEqual(b.pedSpawnTiles);
  });

  it('produces different layouts for different seeds', () => {
    const a = generateDowntown(1);
    const b = generateDowntown(2);
    const tilesDiffer = Array.from(a.tiles).some((t, i) => t !== b.tiles[i]);
    const pickupsDiffer = JSON.stringify(a.pickups) !== JSON.stringify(b.pickups);
    expect(tilesDiffer || pickupsDiffer).toBe(true);
  });

  it('is 64x64 tiles', () => {
    const map = generateDowntown(1997);
    expect(map.width).toBe(64);
    expect(map.height).toBe(64);
    expect(map.tiles.length).toBe(64 * 64);
    expect(map.worldWidth()).toBe(64 * TILE);
    expect(map.worldHeight()).toBe(64 * TILE);
  });

  it('has a 2-tile water border on every side', () => {
    const map = generateDowntown(1997);
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (x < 2 || y < 2 || x >= map.width - 2 || y >= map.height - 2) {
          expect(map.tileAt(x, y)).toBe(Tile.Water);
        }
      }
    }
    // and out-of-bounds reads behave like water
    expect(map.tileAt(-1, 5)).toBe(Tile.Water);
    expect(map.tileAt(5, 999)).toBe(Tile.Water);
  });

  it('places the player spawn on a non-solid (sidewalk) tile', () => {
    const map = generateDowntown(1997);
    const tx = Math.floor(map.playerSpawn.x / TILE);
    const ty = Math.floor(map.playerSpawn.y / TILE);
    expect(map.isSolidTile(tx, ty)).toBe(false);
    expect(map.tileAt(tx, ty)).toBe(Tile.Sidewalk);
  });

  it('contains road, sidewalk and building tiles', () => {
    const map = generateDowntown(1997);
    const counts = new Map<number, number>();
    for (const t of map.tiles) counts.set(t, (counts.get(t) ?? 0) + 1);
    expect(counts.get(Tile.Road) ?? 0).toBeGreaterThan(0);
    expect(counts.get(Tile.Sidewalk) ?? 0).toBeGreaterThan(0);
    expect(counts.get(Tile.Building) ?? 0).toBeGreaterThan(0);
  });

  it('gives every road tile at least one traffic-flow direction', () => {
    const map = generateDowntown(1997);
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (!map.isRoadTile(x, y)) continue;
        expect(
          flowDirs(map.flowAt(x, y)).length,
          `road tile (${x},${y}) should have flow`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('horizontal roads are two tiles wide with an eastbound south lane', () => {
    const map = generateDowntown(1997);
    const ry = 16;
    const x = 10; // mid-block, away from vertical roads at 6/7 and 16/17
    expect(map.isRoadTile(x, ry)).toBe(true);
    expect(map.isRoadTile(x, ry + 1)).toBe(true);
    expect(map.hasFlow(x, ry + 1, Dir.E)).toBe(true);
  });

  it('vertical lanes follow right-hand traffic: west lane southbound, east lane northbound', () => {
    const map = generateDowntown(1997);
    const rx = 16;
    for (let y = 8; y <= 14; y++) {
      // mid-block (no intersections in 8..14), so each lane tile has exactly one dir
      expect(map.isRoadTile(rx, y)).toBe(true);
      expect(map.isRoadTile(rx + 1, y)).toBe(true);
      expect(flowDirs(map.flowAt(rx, y))).toEqual([Dir.S]);
      expect(flowDirs(map.flowAt(rx + 1, y))).toEqual([Dir.N]);
    }
  });

  it('horizontal north lane follows right-hand traffic: westbound', () => {
    const map = generateDowntown(1997);
    const ry = 16;
    for (let x = 9; x <= 14; x++) {
      // mid-block columns between vertical roads
      expect(map.isRoadTile(x, ry)).toBe(true);
      expect(map.hasFlow(x, ry, Dir.W)).toBe(true);
    }
  });

  it('intersection tiles carry the union of crossing flows', () => {
    const map = generateDowntown(1997);
    // (16,16) is the NW tile of the crossing of vertical road x=16/17 and
    // horizontal road y=16: southbound + westbound.
    const dirs = flowDirs(map.flowAt(16, 16));
    expect(dirs).toContain(Dir.S);
    expect(dirs).toContain(Dir.W);
  });

  it('car spawns sit on road tiles with exactly one flow direction', () => {
    const map = generateDowntown(1997);
    expect(map.carSpawns.length).toBeGreaterThan(0);
    for (const s of map.carSpawns) {
      expect(map.isRoadTile(s.tx, s.ty)).toBe(true);
      const dirs = flowDirs(map.flowAt(s.tx, s.ty));
      expect(dirs).toHaveLength(1);
      expect(dirs[0]).toBe(s.dir);
    }
  });

  it('places all pickups on sidewalk tiles', () => {
    const map = generateDowntown(1997);
    expect(map.pickups).toHaveLength(8);
    for (const p of map.pickups) {
      expect(map.tileAt(p.tx, p.ty)).toBe(Tile.Sidewalk);
    }
  });
});

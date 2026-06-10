import { Dir, Tile, TILE, Vec2 } from './types';
import { Rng } from './rng';

export interface CarSpawn {
  tx: number;
  ty: number;
  dir: Dir;
}

export interface PickupSpawn {
  tx: number;
  ty: number;
  kind: 'pistol' | 'uzi' | 'shotgun' | 'health';
}

const ROAD_POSITIONS = [6, 16, 26, 36, 46, 56]; // left/top column of each 2-wide road
const MAP_SIZE = 64;

export class GameMap {
  readonly width: number;
  readonly height: number;
  readonly tiles: Uint8Array;
  /** Bitmask of allowed AI travel directions per tile: 1 << Dir. */
  readonly flows: Uint8Array;
  playerSpawn: Vec2 = { x: 0, y: 0 };
  carSpawns: CarSpawn[] = [];
  pedSpawnTiles: Vec2[] = []; // tile coords of sidewalks
  pickups: PickupSpawn[] = [];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.tiles = new Uint8Array(width * height);
    this.flows = new Uint8Array(width * height);
  }

  inBounds(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.width && ty < this.height;
  }

  tileAt(tx: number, ty: number): Tile {
    if (!this.inBounds(tx, ty)) return Tile.Water;
    return this.tiles[ty * this.width + tx] as Tile;
  }

  setTile(tx: number, ty: number, t: Tile): void {
    if (this.inBounds(tx, ty)) this.tiles[ty * this.width + tx] = t;
  }

  flowAt(tx: number, ty: number): number {
    if (!this.inBounds(tx, ty)) return 0;
    return this.flows[ty * this.width + tx];
  }

  hasFlow(tx: number, ty: number, dir: Dir): boolean {
    return (this.flowAt(tx, ty) & (1 << dir)) !== 0;
  }

  /** Solid for people and bullets. */
  isSolidTile(tx: number, ty: number): boolean {
    const t = this.tileAt(tx, ty);
    return t === Tile.Building || t === Tile.Water;
  }

  /** Solid lookup in world coordinates. */
  isSolidAt(x: number, y: number): boolean {
    return this.isSolidTile(Math.floor(x / TILE), Math.floor(y / TILE));
  }

  isRoadTile(tx: number, ty: number): boolean {
    const t = this.tileAt(tx, ty);
    return t === Tile.Road || t === Tile.RoadMarking;
  }

  worldWidth(): number {
    return this.width * TILE;
  }

  worldHeight(): number {
    return this.height * TILE;
  }
}

export function tileCenter(tx: number, ty: number): Vec2 {
  return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
}

/**
 * Generates the "Downtown" district: an island ringed by water, a grid of
 * two-lane roads with right-hand traffic, sidewalks, buildings and parks.
 * Deterministic for a given seed.
 */
export function generateDowntown(seed = 1997): GameMap {
  const map = new GameMap(MAP_SIZE, MAP_SIZE);
  const rng = new Rng(seed);
  const w = map.width;
  const h = map.height;
  const first = ROAD_POSITIONS[0];
  const last = ROAD_POSITIONS[ROAD_POSITIONS.length - 1] + 1;

  // 1. Grass base, water border.
  map.tiles.fill(Tile.Grass);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) map.setTile(x, y, Tile.Water);
    }
  }

  // 2. Roads: vertical and horizontal 2-wide strips spanning the road grid.
  for (const rx of ROAD_POSITIONS) {
    for (let y = first; y <= last; y++) {
      map.setTile(rx, y, Tile.Road);
      map.setTile(rx + 1, y, Tile.Road);
    }
  }
  for (const ry of ROAD_POSITIONS) {
    for (let x = first; x <= last; x++) {
      map.setTile(x, ry, Tile.Road);
      map.setTile(x + 1, ry, Tile.Road);
    }
  }

  // 3. Traffic flow (right-hand): vertical roads — west lane southbound,
  // east lane northbound; horizontal roads — north lane westbound, south
  // lane eastbound. Intersection tiles get the union, which lets AI turn.
  for (const rx of ROAD_POSITIONS) {
    for (let y = first; y <= last; y++) {
      if (map.isRoadTile(rx, y)) map.flows[y * w + rx] |= 1 << Dir.S;
      if (map.isRoadTile(rx + 1, y)) map.flows[y * w + rx + 1] |= 1 << Dir.N;
    }
  }
  for (const ry of ROAD_POSITIONS) {
    for (let x = first; x <= last; x++) {
      if (map.isRoadTile(x, ry)) map.flows[ry * w + x] |= 1 << Dir.W;
      if (map.isRoadTile(x, ry + 1)) map.flows[(ry + 1) * w + x] |= 1 << Dir.E;
    }
  }

  // 4. Sidewalks: every grass tile orthogonally adjacent to a road.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (map.tileAt(x, y) !== Tile.Grass) continue;
      if (
        map.isRoadTile(x - 1, y) ||
        map.isRoadTile(x + 1, y) ||
        map.isRoadTile(x, y - 1) ||
        map.isRoadTile(x, y + 1)
      ) {
        map.setTile(x, y, Tile.Sidewalk);
      }
    }
  }

  // 5. City blocks between roads: mostly buildings, some parks.
  for (let i = 0; i < ROAD_POSITIONS.length - 1; i++) {
    for (let j = 0; j < ROAD_POSITIONS.length - 1; j++) {
      const x0 = ROAD_POSITIONS[i] + 3; // road(2) + sidewalk(1)
      const x1 = ROAD_POSITIONS[i + 1] - 2;
      const y0 = ROAD_POSITIONS[j] + 3;
      const y1 = ROAD_POSITIONS[j + 1] - 2;
      const isPark = rng.chance(0.22);
      if (isPark) continue; // leave grass
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          map.setTile(x, y, Tile.Building);
        }
      }
    }
  }

  // 6. Collect spawn data.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (map.tileAt(x, y) === Tile.Sidewalk) map.pedSpawnTiles.push({ x, y });
    }
  }

  // Player spawns on the sidewalk closest to the map centre.
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const t of map.pedSpawnTiles) {
    const d = Math.hypot(t.x - w / 2, t.y - h / 2);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  const spawn = best ?? { x: w / 2, y: h / 2 };
  map.playerSpawn = tileCenter(spawn.x, spawn.y);

  // Traffic car spawns: lane tiles (exactly one flow dir), away from
  // intersections, spaced out.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const f = map.flows[y * w + x];
      if (f === 0) continue;
      const dirs = flowDirs(f);
      if (dirs.length !== 1) continue;
      if ((x + y * 3) % 11 !== 0) continue; // deterministic spacing
      map.carSpawns.push({ tx: x, ty: y, dir: dirs[0] });
    }
  }

  // Weapon & health pickups on random sidewalks (deterministic via rng).
  const kinds: PickupSpawn['kind'][] = [
    'pistol', 'pistol', 'uzi', 'uzi', 'shotgun', 'health', 'health', 'health',
  ];
  for (const kind of kinds) {
    const t = rng.pick(map.pedSpawnTiles);
    map.pickups.push({ tx: t.x, ty: t.y, kind });
  }

  return map;
}

export function flowDirs(mask: number): Dir[] {
  const out: Dir[] = [];
  for (const d of [Dir.N, Dir.E, Dir.S, Dir.W]) {
    if (mask & (1 << d)) out.push(d);
  }
  return out;
}

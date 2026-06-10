import { Car } from './car';
import { flowDirs, GameMap, tileCenter } from './map';
import { Rng } from './rng';
import { angleDiff, Dir, DIR_VEC, TILE, Vec2 } from './types';

const CRUISE_SPEED = 85;
const AHEAD_BRAKE_DIST = 55;

const OPPOSITE: Record<Dir, Dir> = {
  [Dir.None]: Dir.None,
  [Dir.N]: Dir.S,
  [Dir.S]: Dir.N,
  [Dir.E]: Dir.W,
  [Dir.W]: Dir.E,
};

/**
 * Lane-following AI: drives tile to tile along the map's traffic-flow
 * directions, turning at intersections, braking for obstacles ahead.
 */
export class TrafficDriver {
  readonly car: Car;
  private targetTile: Vec2 | null = null;
  private dir: Dir;

  constructor(car: Car, dir: Dir) {
    this.car = car;
    this.dir = dir;
    car.driver = 'ai';
  }

  update(dt: number, map: GameMap, rng: Rng, obstacles: Vec2[]): void {
    void dt;
    const car = this.car;
    if (car.exploded || car.driver !== 'ai') return;

    if (!this.targetTile) this.pickNextTarget(map, rng);
    if (!this.targetTile) {
      car.controls = { throttle: 0, steer: 0, handbrake: false };
      return;
    }

    const target = tileCenter(this.targetTile.x, this.targetTile.y);
    const dx = target.x - car.pos.x;
    const dy = target.y - car.pos.y;
    if (Math.hypot(dx, dy) < TILE * 0.45) {
      this.advanceTarget(map, rng);
      return;
    }

    const desired = Math.atan2(dy, dx);
    const diff = angleDiff(car.heading, desired);
    const steer = Math.max(-1, Math.min(1, diff * 2.5));

    // Brake when something is ahead of us in our travel direction.
    let blocked = false;
    const hx = Math.cos(car.heading);
    const hy = Math.sin(car.heading);
    for (const o of obstacles) {
      const ox = o.x - car.pos.x;
      const oy = o.y - car.pos.y;
      const along = ox * hx + oy * hy;
      const side = Math.abs(-ox * hy + oy * hx);
      if (along > 0 && along < AHEAD_BRAKE_DIST && side < car.type.width + 8) {
        blocked = true;
        break;
      }
    }

    const tooFast = car.forwardSpeed() > CRUISE_SPEED;
    const sharpTurn = Math.abs(diff) > 0.6 && car.forwardSpeed() > 50;
    const throttle = blocked ? -1 : tooFast || sharpTurn ? 0 : 0.65;
    car.controls = { throttle, steer, handbrake: false };
  }

  private currentTile(): Vec2 {
    return {
      x: Math.floor(this.car.pos.x / TILE),
      y: Math.floor(this.car.pos.y / TILE),
    };
  }

  private pickNextTarget(map: GameMap, rng: Rng): void {
    const t = this.currentTile();
    const next = this.chooseDir(map, rng, t.x, t.y);
    if (next === Dir.None) {
      this.targetTile = null;
      return;
    }
    this.dir = next;
    const v = DIR_VEC[next];
    this.targetTile = { x: t.x + v.x, y: t.y + v.y };
  }

  private advanceTarget(map: GameMap, rng: Rng): void {
    if (!this.targetTile) return;
    const { x, y } = this.targetTile;
    const next = this.chooseDir(map, rng, x, y);
    if (next === Dir.None) {
      // Dead end: U-turn.
      this.dir = OPPOSITE[this.dir];
      const v = DIR_VEC[this.dir];
      this.targetTile = { x: x + v.x, y: y + v.y };
      return;
    }
    this.dir = next;
    const v = DIR_VEC[next];
    this.targetTile = { x: x + v.x, y: y + v.y };
  }

  /** Pick an allowed direction from a tile, preferring to go straight. */
  private chooseDir(map: GameMap, rng: Rng, tx: number, ty: number): Dir {
    const candidates = flowDirs(map.flowAt(tx, ty)).filter((d) => {
      if (d === OPPOSITE[this.dir]) return false;
      const v = DIR_VEC[d];
      // Only move onto tiles that allow continuing in that direction.
      return map.hasFlow(tx + v.x, ty + v.y, d) || flowDirs(map.flowAt(tx + v.x, ty + v.y)).length > 0;
    });
    if (candidates.length === 0) return Dir.None;
    if (candidates.includes(this.dir) && rng.chance(0.7)) return this.dir;
    return rng.pick(candidates);
  }
}

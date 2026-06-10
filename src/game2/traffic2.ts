import { Rng } from '../sim/rng';
import { angleDiff, Vec2 } from '../sim/types';
import { Car2 } from './car2';
import { ArrowDirs, CityMap } from './citymap';

const CRUISE_SPEED = 2.1;
const AHEAD_BRAKE_DIST = 1.1;

type DirName = 'west' | 'east' | 'north' | 'south';

const DIR_VEC: Record<DirName, Vec2> = {
  west: { x: -1, y: 0 },
  east: { x: 1, y: 0 },
  north: { x: 0, y: -1 },
  south: { x: 0, y: 1 },
};

const OPPOSITE: Record<DirName, DirName> = {
  west: 'east', east: 'west', north: 'south', south: 'north',
};

function available(a: ArrowDirs): DirName[] {
  return (Object.keys(DIR_VEC) as DirName[]).filter((d) => a[d]);
}

/**
 * AI driver following the map's green-arrow road network, exactly like
 * GTA2's "dummy cars": at each block, continue along an allowed arrow,
 * preferring straight ahead; brake for obstacles.
 */
export class TrafficAI {
  readonly car: Car2;
  private dir: DirName;
  private target: Vec2 | null = null;

  constructor(car: Car2, dir: DirName) {
    this.car = car;
    this.dir = dir;
    car.driver = 'ai';
  }

  update(dt: number, map: CityMap, rng: Rng, obstacles: Vec2[]): void {
    void dt;
    const car = this.car;
    if (car.exploded || car.driver !== 'ai') return;

    if (!this.target) this.advance(map, rng, Math.floor(car.pos.x), Math.floor(car.pos.y));
    if (!this.target) {
      car.controls = { throttle: 0, steer: 0, handbrake: false };
      return;
    }

    const dx = this.target.x - car.pos.x;
    const dy = this.target.y - car.pos.y;
    if (Math.hypot(dx, dy) < 0.4) {
      this.advance(map, rng, Math.floor(this.target.x), Math.floor(this.target.y));
      return;
    }

    const desired = Math.atan2(dy, dx);
    const diff = angleDiff(car.heading, desired);
    const steer = Math.max(-1, Math.min(1, diff * 2.5));

    let blocked = false;
    const hx = Math.cos(car.heading);
    const hy = Math.sin(car.heading);
    for (const o of obstacles) {
      const ox = o.x - car.pos.x;
      const oy = o.y - car.pos.y;
      const along = ox * hx + oy * hy;
      const side = Math.abs(-ox * hy + oy * hx);
      if (along > 0.1 && along < AHEAD_BRAKE_DIST && side < car.width + 0.15) {
        blocked = true;
        break;
      }
    }

    const sharpTurn = Math.abs(diff) > 0.6 && car.forwardSpeed() > 1.2;
    const tooFast = car.forwardSpeed() > CRUISE_SPEED;
    car.controls = {
      throttle: blocked ? -1 : tooFast || sharpTurn ? 0 : 0.6,
      steer,
      handbrake: false,
    };
  }

  /** Choose the next block centre to drive to from block (bx, by). */
  private advance(map: CityMap, rng: Rng, bx: number, by: number): void {
    const arrows = map.arrowsAt(bx + 0.5, by + 0.5, this.car.z);
    let dirs = available(arrows).filter((d) => d !== OPPOSITE[this.dir]);
    if (dirs.length === 0) {
      // dead end or off-network: try a U-turn if the road allows, else stop
      dirs = available(arrows);
      if (dirs.length === 0) {
        this.target = null;
        return;
      }
    }
    const next = dirs.includes(this.dir) && rng.chance(0.65) ? this.dir : rng.pick(dirs);
    this.dir = next;
    const v = DIR_VEC[next];
    this.target = { x: bx + v.x + 0.5, y: by + v.y + 0.5 };
  }
}

export function dirNameFromArrows(a: ArrowDirs, rng: Rng): DirName | null {
  const dirs = available(a);
  return dirs.length ? rng.pick(dirs) : null;
}

export function dirAngle(d: DirName): number {
  switch (d) {
    case 'east': return 0;
    case 'south': return Math.PI / 2;
    case 'west': return Math.PI;
    case 'north': return -Math.PI / 2;
  }
}

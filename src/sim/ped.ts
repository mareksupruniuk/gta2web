import { GameMap, tileCenter } from './map';
import { Rng } from './rng';
import { GameEvent, Tile, TILE, Vec2, dist, vec } from './types';

export type PedState = 'walk' | 'flee' | 'dead';

const WALK_SPEED = 28;
const FLEE_SPEED = 85;
export const PED_RADIUS = 6;

let nextId = 1;

export class Ped {
  readonly id = nextId++;
  pos: Vec2;
  heading = 0;
  state: PedState = 'walk';
  health = 20;
  /** sprite variant index, assigned at spawn */
  variant: number;
  private dirTimer = 0;
  private fleeFrom: Vec2 = vec();
  private fleeTimer = 0;

  constructor(pos: Vec2, variant: number) {
    this.pos = { ...pos };
    this.variant = variant;
  }

  get dead(): boolean {
    return this.state === 'dead';
  }

  /** Scare the ped away from a threat position. */
  panic(threat: Vec2): void {
    if (this.dead) return;
    this.state = 'flee';
    this.fleeFrom = { ...threat };
    this.fleeTimer = 4;
  }

  applyDamage(amount: number, emit: (e: GameEvent) => void, threat?: Vec2): void {
    if (this.dead) return;
    this.health -= amount;
    if (this.health <= 0) {
      this.state = 'dead';
      emit({ type: 'ped_killed', pos: { ...this.pos } });
    } else {
      this.panic(threat ?? this.pos);
      emit({ type: 'ped_scream', pos: { ...this.pos } });
    }
  }

  update(dt: number, map: GameMap, rng: Rng): void {
    if (this.dead) return;

    let speed = WALK_SPEED;
    if (this.state === 'flee') {
      speed = FLEE_SPEED;
      this.fleeTimer -= dt;
      this.heading = Math.atan2(this.pos.y - this.fleeFrom.y, this.pos.x - this.fleeFrom.x);
      // small jitter so crowds don't overlap perfectly
      this.heading += (rng.next() - 0.5) * 0.3;
      if (this.fleeTimer <= 0) this.state = 'walk';
    } else {
      this.dirTimer -= dt;
      if (this.dirTimer <= 0) {
        this.dirTimer = rng.range(1.5, 4);
        this.heading = this.pickWalkHeading(map, rng);
      }
    }

    const nx = this.pos.x + Math.cos(this.heading) * speed * dt;
    const ny = this.pos.y + Math.sin(this.heading) * speed * dt;
    if (!map.isSolidAt(nx, this.pos.y)) this.pos.x = nx;
    else this.dirTimer = 0;
    if (!map.isSolidAt(this.pos.x, ny)) this.pos.y = ny;
    else this.dirTimer = 0;
  }

  /** Prefer walking toward a nearby sidewalk tile; cross roads occasionally. */
  private pickWalkHeading(map: GameMap, rng: Rng): number {
    const tx = Math.floor(this.pos.x / TILE);
    const ty = Math.floor(this.pos.y / TILE);
    const options: Vec2[] = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const t = map.tileAt(tx + dx, ty + dy);
      if (t === Tile.Sidewalk || t === Tile.Grass) {
        options.push(tileCenter(tx + dx, ty + dy));
        // weight sidewalks double
        if (t === Tile.Sidewalk) options.push(tileCenter(tx + dx, ty + dy));
      } else if (t === Tile.Road && rng.chance(0.15)) {
        options.push(tileCenter(tx + dx, ty + dy)); // jaywalk sometimes
      }
    }
    if (options.length === 0) return rng.range(0, Math.PI * 2);
    const target = rng.pick(options);
    return Math.atan2(target.y - this.pos.y, target.x - this.pos.x);
  }
}

/** Peds within this distance of a gunshot panic. */
export const PANIC_RADIUS = 180;

export function panicNearby(peds: Ped[], pos: Vec2): void {
  for (const p of peds) {
    if (!p.dead && dist(p.pos, pos) < PANIC_RADIUS) p.panic(pos);
  }
}

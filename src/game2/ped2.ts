import { GroundType } from '../gta2/gmp';
import { Rng } from '../sim/rng';
import { GameEvent, Vec2, dist, vec } from '../sim/types';
import { CityMap } from './citymap';

export type PedState = 'walk' | 'flee' | 'dead';

const WALK_SPEED = 0.55;
const FLEE_SPEED = 1.9;
export const PED_RADIUS = 0.13;
export const PANIC_RADIUS = 3.2;

let nextId = 1;

export class Ped2 {
  readonly id = nextId++;
  pos: Vec2;
  z: number;
  heading = 0;
  state: PedState = 'walk';
  health = 20;
  /** ped colour remap (virtual, relative to ped remap area), -1 = default */
  remap: number;
  animTime = 0;
  private dirTimer = 0;
  private fleeFrom: Vec2 = vec();
  private fleeTimer = 0;

  constructor(pos: Vec2, z: number, remap: number) {
    this.pos = { ...pos };
    this.z = z;
    this.remap = remap;
  }

  get dead(): boolean {
    return this.state === 'dead';
  }

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

  update(dt: number, map: CityMap, rng: Rng): void {
    if (this.dead) return;
    this.animTime += dt;

    let speed = WALK_SPEED;
    if (this.state === 'flee') {
      speed = FLEE_SPEED;
      this.fleeTimer -= dt;
      const dx = this.pos.x - this.fleeFrom.x;
      const dy = this.pos.y - this.fleeFrom.y;
      if (dx !== 0 || dy !== 0) this.heading = Math.atan2(dy, dx);
      this.heading += (rng.next() - 0.5) * 0.25;
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
    if (map.canMoveBody(this.pos.x, this.pos.y, nx, this.pos.y, this.z, PED_RADIUS, 0.6)) this.pos.x = nx;
    else this.dirTimer = 0;
    if (map.canMoveBody(this.pos.x, this.pos.y, this.pos.x, ny, this.z, PED_RADIUS, 0.6)) this.pos.y = ny;
    else this.dirTimer = 0;
    const g = map.groundZ(this.pos.x, this.pos.y, this.z + 0.55);
    if (g !== null) this.z = g < this.z - 0.05 ? Math.max(g, this.z - 4 * dt) : g;
  }

  /** Head for a neighbouring pavement block centre; jaywalk occasionally. */
  private pickWalkHeading(map: CityMap, rng: Rng): number {
    const bx = Math.floor(this.pos.x);
    const by = Math.floor(this.pos.y);
    const options: Vec2[] = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const cx = bx + dx + 0.5;
      const cy = by + dy + 0.5;
      if (!map.canMove(this.pos.x, this.pos.y, cx, cy, this.z, 0.6)) continue;
      const g = map.groundTypeAt(cx, cy, this.z);
      if (g === GroundType.Pavement || g === GroundType.Field) {
        options.push({ x: cx, y: cy }, { x: cx, y: cy }); // double weight
      } else if (g === GroundType.Road && rng.chance(0.12)) {
        options.push({ x: cx, y: cy });
      }
    }
    if (options.length === 0) return rng.range(0, Math.PI * 2);
    const t = rng.pick(options);
    return Math.atan2(t.y - this.pos.y, t.x - this.pos.x);
  }
}

export function panicNearby(peds: Ped2[], pos: Vec2): void {
  for (const p of peds) {
    if (!p.dead && dist(p.pos, pos) < PANIC_RADIUS) p.panic(pos);
  }
}

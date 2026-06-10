import { Car } from './car';
import { GameMap } from './map';
import { Inventory } from './weapons';
import { Vec2 } from './types';

export const PLAYER_RADIUS = 7;
const WALK_SPEED = 95;

export interface PlayerInput {
  /** -1..1 movement / steering axes */
  moveX: number;
  moveY: number;
  attack: boolean;
  enterExit: boolean; // edge-triggered by the input layer
  nextWeapon: boolean; // edge-triggered
  prevWeapon: boolean; // edge-triggered
}

export class Player {
  pos: Vec2;
  heading = -Math.PI / 2;
  health = 100;
  inventory = new Inventory();
  car: Car | null = null;
  score = 0;
  dead = false;

  constructor(spawn: Vec2) {
    this.pos = { ...spawn };
  }

  /** On-foot movement; driving is handled by the world via car controls. */
  updateOnFoot(dt: number, input: PlayerInput, map: GameMap): void {
    if (this.dead || this.car) return;
    const mx = input.moveX;
    const my = input.moveY;
    const mag = Math.hypot(mx, my);
    if (mag > 0.01) {
      const nx = mx / Math.max(1, mag);
      const ny = my / Math.max(1, mag);
      this.heading = Math.atan2(ny, nx);
      const px = this.pos.x + nx * WALK_SPEED * dt;
      const py = this.pos.y + ny * WALK_SPEED * dt;
      // Axis-separated collision so the player slides along walls.
      if (!circleSolid(map, px, this.pos.y)) this.pos.x = px;
      if (!circleSolid(map, this.pos.x, py)) this.pos.y = py;
    }
  }

  applyDamage(amount: number): void {
    if (this.dead) return;
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
    }
  }
}

function circleSolid(map: GameMap, x: number, y: number): boolean {
  const r = PLAYER_RADIUS;
  return (
    map.isSolidAt(x - r, y) ||
    map.isSolidAt(x + r, y) ||
    map.isSolidAt(x, y - r) ||
    map.isSolidAt(x, y + r)
  );
}

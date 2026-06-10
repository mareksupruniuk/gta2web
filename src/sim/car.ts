import { GameMap } from './map';
import { GameEvent, Vec2, vec, wrapAngle } from './types';

export interface CarType {
  id: string;
  /** world units */
  length: number;
  width: number;
  accel: number; // u/s^2
  maxSpeed: number; // u/s
  reverseSpeed: number; // u/s (positive)
  turnRate: number; // rad/s at full grip speed
  grip: number; // lateral damping factor (1/s), higher = less drift
  color: number; // base tint used by procedural sprites
}

export const CAR_TYPES: CarType[] = [
  { id: 'sedan', length: 30, width: 16, accel: 140, maxSpeed: 220, reverseSpeed: 80, turnRate: 2.6, grip: 8, color: 0xc0392b },
  { id: 'taxi', length: 30, width: 16, accel: 150, maxSpeed: 230, reverseSpeed: 80, turnRate: 2.8, grip: 8, color: 0xf1c40f },
  { id: 'sport', length: 28, width: 15, accel: 200, maxSpeed: 300, reverseSpeed: 90, turnRate: 3.2, grip: 9, color: 0x2980b9 },
  { id: 'truck', length: 40, width: 19, accel: 90, maxSpeed: 160, reverseSpeed: 60, turnRate: 1.8, grip: 7, color: 0x7f8c8d },
  { id: 'bus', length: 46, width: 20, accel: 80, maxSpeed: 150, reverseSpeed: 55, turnRate: 1.6, grip: 7, color: 0x27ae60 },
];

export interface CarControls {
  throttle: number; // -1..1 (negative = brake/reverse)
  steer: number; // -1..1 (negative = left)
  handbrake: boolean;
}

let nextId = 1;

export class Car {
  readonly id = nextId++;
  readonly type: CarType;
  pos: Vec2;
  heading: number; // radians, 0 = +x
  vel: Vec2 = vec();
  health = 100;
  /** 'player' when driven by the player, 'ai' for traffic, null when parked. */
  driver: 'player' | 'ai' | null = null;
  controls: CarControls = { throttle: 0, steer: 0, handbrake: false };
  exploded = false;
  /** seconds since last crash event, to rate-limit crash sounds */
  private crashCooldown = 0;

  constructor(type: CarType, pos: Vec2, heading: number) {
    this.type = type;
    this.pos = { ...pos };
    this.heading = heading;
  }

  /** Signed speed along the heading (negative = reversing). */
  forwardSpeed(): number {
    return this.vel.x * Math.cos(this.heading) + this.vel.y * Math.sin(this.heading);
  }

  speed(): number {
    return Math.hypot(this.vel.x, this.vel.y);
  }

  /** Corner positions in world space, for tile collision. */
  corners(): Vec2[] {
    const c = Math.cos(this.heading);
    const s = Math.sin(this.heading);
    const hl = this.type.length / 2;
    const hw = this.type.width / 2;
    const out: Vec2[] = [];
    for (const [dx, dy] of [[hl, hw], [hl, -hw], [-hl, hw], [-hl, -hw]] as const) {
      out.push({ x: this.pos.x + dx * c - dy * s, y: this.pos.y + dx * s + dy * c });
    }
    return out;
  }

  private anyCornerSolid(map: GameMap): boolean {
    return this.corners().some((p) => map.isSolidAt(p.x, p.y));
  }

  update(dt: number, map: GameMap, emit: (e: GameEvent) => void): void {
    if (this.exploded) return;
    this.crashCooldown = Math.max(0, this.crashCooldown - dt);

    const t = this.type;
    const cos = Math.cos(this.heading);
    const sin = Math.sin(this.heading);
    // Decompose velocity into car-local axes.
    let fwd = this.vel.x * cos + this.vel.y * sin;
    let lat = -this.vel.x * sin + this.vel.y * cos;

    const { throttle, steer, handbrake } = this.controls;
    if (this.driver) {
      if (throttle > 0) {
        fwd += throttle * t.accel * dt;
      } else if (throttle < 0) {
        // Brake first, then reverse.
        if (fwd > 5) fwd += throttle * t.accel * 2 * dt;
        else fwd += throttle * t.accel * 0.7 * dt;
      }
    }
    // Drag + rolling resistance.
    const drag = this.driver && throttle !== 0 ? 0.18 : 1.0;
    fwd -= fwd * drag * dt;
    if (Math.abs(fwd) < 1 && throttle === 0) fwd = 0;
    fwd = Math.min(t.maxSpeed, Math.max(-t.reverseSpeed, fwd));

    // Lateral grip: tires resist sideways motion; handbrake lets the rear slide.
    const grip = handbrake ? t.grip * 0.25 : t.grip;
    lat -= lat * Math.min(1, grip * dt);

    // Steering effectiveness scales with speed (no turning in place).
    const speedFactor = Math.min(1, Math.abs(fwd) / 60);
    const dir = fwd >= 0 ? 1 : -1;
    this.heading = wrapAngle(this.heading + steer * t.turnRate * speedFactor * dir * dt);

    const nc = Math.cos(this.heading);
    const ns = Math.sin(this.heading);
    this.vel.x = fwd * nc - lat * ns;
    this.vel.y = fwd * ns + lat * nc;

    // Move with axis-separated tile collision.
    const impactSpeed = this.speed();
    let crashed = false;

    this.pos.x += this.vel.x * dt;
    if (this.anyCornerSolid(map)) {
      this.pos.x -= this.vel.x * dt;
      this.vel.x *= -0.25;
      crashed = true;
    }
    this.pos.y += this.vel.y * dt;
    if (this.anyCornerSolid(map)) {
      this.pos.y -= this.vel.y * dt;
      this.vel.y *= -0.25;
      crashed = true;
    }

    if (crashed && impactSpeed > 40) {
      this.applyDamage(impactSpeed * 0.08, emit);
      if (this.crashCooldown === 0) {
        emit({ type: 'car_crash', pos: { ...this.pos }, speed: impactSpeed });
        this.crashCooldown = 0.4;
      }
    }
  }

  applyDamage(amount: number, emit: (e: GameEvent) => void): void {
    if (this.exploded) return;
    this.health -= amount;
    if (this.health <= 0) {
      this.exploded = true;
      this.vel = vec();
      emit({ type: 'explosion', pos: { ...this.pos } });
    }
  }
}

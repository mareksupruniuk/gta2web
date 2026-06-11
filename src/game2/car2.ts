import { CarInfo } from '../gta2/sty';
import { GameEvent, Vec2, vec, wrapAngle } from '../sim/types';
import { CityMap } from './citymap';

/**
 * Arcade car physics in block units on the real map. Handling tiers come
 * from the style file's quality `rating` (1x=bad, 1y=average, 2y=good).
 */

export interface Handling {
  accel: number;
  maxSpeed: number;
  reverseSpeed: number;
  turnRate: number;
  grip: number;
}

export function handlingFor(info: CarInfo): Handling {
  const tier = info.rating >= 21 ? 2 : info.rating >= 11 ? 1 : 0;
  const size = info.h / 64; // length in blocks
  const sizePenalty = Math.max(0, size - 0.9) * 0.8;
  return {
    accel: [2.6, 3.4, 4.6][tier] - sizePenalty,
    maxSpeed: [4.2, 5.4, 7.0][tier] - sizePenalty,
    reverseSpeed: 1.8,
    turnRate: [2.4, 2.9, 3.4][tier] - sizePenalty * 0.5,
    grip: 9,
  };
}

export interface CarControls {
  throttle: number; // -1..1
  steer: number; // -1..1
  handbrake: boolean;
}

let nextId = 1;

export class Car2 {
  readonly id = nextId++;
  readonly info: CarInfo;
  readonly handling: Handling;
  /** chosen colour remap (virtual, relative to car remap area) or -1 */
  readonly remap: number;
  pos: Vec2;
  z: number;
  heading: number;
  vel: Vec2 = vec();
  health = 100;
  driver: 'player' | 'ai' | null = null;
  controls: CarControls = { throttle: 0, steer: 0, handbrake: false };
  exploded = false;
  /** GTA2: a badly damaged car catches fire and burns before exploding. */
  onFire = false;
  private burnTime = 0;
  /** length/width in blocks (style stores pixels, 64 px = 1 block) */
  readonly length: number;
  readonly width: number;
  private crashCooldown = 0;

  constructor(info: CarInfo, remap: number, pos: Vec2, z: number, heading: number) {
    this.info = info;
    this.handling = handlingFor(info);
    this.remap = remap;
    this.pos = { ...pos };
    this.z = z;
    this.heading = heading;
    this.length = info.h / 64;
    this.width = info.w / 64;
  }

  forwardSpeed(): number {
    return this.vel.x * Math.cos(this.heading) + this.vel.y * Math.sin(this.heading);
  }

  speed(): number {
    return Math.hypot(this.vel.x, this.vel.y);
  }

  corners(): Vec2[] {
    const c = Math.cos(this.heading);
    const s = Math.sin(this.heading);
    const hl = this.length / 2;
    const hw = this.width / 2;
    const out: Vec2[] = [];
    for (const [dx, dy] of [[hl, hw], [hl, -hw], [-hl, hw], [-hl, -hw]] as const) {
      out.push({ x: this.pos.x + dx * c - dy * s, y: this.pos.y + dx * s + dy * c });
    }
    return out;
  }

  private collides(map: CityMap, from: Vec2[], inflate = 0): boolean {
    const now = this.corners();
    for (let i = 0; i < 4; i++) {
      if (!map.canMove(from[i].x, from[i].y, now[i].x, now[i].y, this.z + 0.05, 0.55 + inflate)) {
        return true;
      }
    }
    return false;
  }

  update(dt: number, map: CityMap, emit: (e: GameEvent) => void): void {
    if (this.exploded) return;
    this.crashCooldown = Math.max(0, this.crashCooldown - dt);

    // Burning cars cook off after a few seconds.
    if (this.onFire) {
      this.burnTime += dt;
      if (this.burnTime > 4) {
        this.explode(emit);
        return;
      }
    }

    const h = this.handling;
    const cos = Math.cos(this.heading);
    const sin = Math.sin(this.heading);
    let fwd = this.vel.x * cos + this.vel.y * sin;
    let lat = -this.vel.x * sin + this.vel.y * cos;

    const { throttle, steer, handbrake } = this.controls;
    if (this.driver) {
      if (throttle > 0) fwd += throttle * h.accel * dt;
      else if (throttle < 0) {
        if (fwd > 0.15) fwd += throttle * h.accel * 2.2 * dt; // braking
        else fwd += throttle * h.accel * 0.6 * dt; // reversing
      }
    }
    const drag = this.driver && throttle !== 0 ? 0.25 : 1.4;
    fwd -= fwd * drag * dt;
    if (Math.abs(fwd) < 0.02 && throttle === 0) fwd = 0;
    fwd = Math.min(h.maxSpeed, Math.max(-h.reverseSpeed, fwd));

    const grip = handbrake ? h.grip * 0.22 : h.grip;
    lat -= lat * Math.min(1, grip * dt);

    const speedFactor = Math.min(1, Math.abs(fwd) / 1.2);
    const dir = fwd >= 0 ? 1 : -1;
    this.heading = wrapAngle(this.heading + steer * h.turnRate * speedFactor * dir * dt);

    const nc = Math.cos(this.heading);
    const ns = Math.sin(this.heading);
    this.vel.x = fwd * nc - lat * ns;
    this.vel.y = fwd * ns + lat * nc;

    const impactSpeed = this.speed();
    let crashed = false;
    let from = this.corners();

    this.pos.x += this.vel.x * dt;
    if (this.collides(map, from)) {
      this.pos.x -= this.vel.x * dt;
      this.vel.x *= -0.25;
      crashed = true;
    }
    from = this.corners();
    this.pos.y += this.vel.y * dt;
    if (this.collides(map, from)) {
      this.pos.y -= this.vel.y * dt;
      this.vel.y *= -0.25;
      crashed = true;
    }

    // Follow the ground (slopes, bridges); fall quickly over drops.
    const g = map.groundZ(this.pos.x, this.pos.y, this.z + 0.55);
    if (g !== null) {
      if (g < this.z - 0.05) this.z = Math.max(g, this.z - 4 * dt);
      else this.z = g;
    }

    // Event positions/speeds stay in block units; the audio layer rescales.
    if (crashed && impactSpeed > 1.2) {
      this.applyDamage(impactSpeed * 3.2, emit);
      if (this.crashCooldown === 0) {
        emit({ type: 'car_crash', pos: { ...this.pos }, speed: impactSpeed });
        this.crashCooldown = 0.4;
      }
    }
  }

  /**
   * Gradual damage (bullets, crashes): the car catches fire when battered
   * and explodes a few seconds later. `instant` (explosions) skips the burn.
   */
  applyDamage(amount: number, emit: (e: GameEvent) => void, instant = false): void {
    if (this.exploded) return;
    this.health -= amount;
    if (this.health <= 0 && instant) {
      this.explode(emit);
      return;
    }
    if (this.health <= 20 && !this.onFire) {
      this.onFire = true;
      this.burnTime = 0;
      emit({ type: 'car_fire', pos: { ...this.pos } });
    }
  }

  private explode(emit: (e: GameEvent) => void): void {
    if (this.exploded) return;
    this.exploded = true;
    this.onFire = false;
    this.vel = vec();
    emit({ type: 'explosion', pos: { ...this.pos } });
  }
}

import { ModelPhysics } from '../gta2/gci';
import { CarInfo } from '../gta2/sty';
import { GameEvent, Vec2, vec, wrapAngle } from '../sim/types';
import { CityMap } from './citymap';

/**
 * Car physics in block units on the real map, driven by the original
 * per-model handling table (nyc.gci / ModelPhysics, docs §7). gci speeds
 * are tiles/tick @30fps -> ×30 for blocks/s, forces ×900 for blocks/s².
 */

export interface Handling {
  /** blocks/s² per gear (index by current gear 0-2) */
  accel: [number, number, number];
  /** gear shift points, blocks/s */
  gearSpeeds: [number, number];
  maxSpeed: number;
  reverseSpeed: number;
  brakeDecel: number;
  /** raw gci steering values (wheel-angle model, docs §7 + CarPhysics_B0) */
  turnIn: number;
  turnRatio: number;
  grip: number;
  /** lateral speed (blocks/s) where the tires break loose */
  skidThreshold: number;
  /** 0..1, how much the handbrake kills lateral grip */
  handbrakeSlide: number;
  mass: number;
  /** crash-damage multiplier (gci anti_strength; tank 0.25 = very tough) */
  antiStrength: number;
}

const TPS = 30; // gci units are per-tick at 30 fps

/** Per-model handling from nyc.gci, registered at load via setModelPhysics. */
let modelPhysics: Map<number, ModelPhysics> | null = null;

export function setModelPhysics(map: Map<number, ModelPhysics> | null): void {
  modelPhysics = map;
}

function fromPhysics(p: ModelPhysics): Handling {
  // engine: effective thrust = thrust/2 + thrust/5 (+ turbo boost), per gear
  const thrust = p.thrust * 0.7 * (p.turbo ? 1.35 : 1);
  const a = (gear: number) => (thrust * p.gearMult[gear] * TPS * TPS) / p.mass;
  return {
    accel: [a(0), a(1), a(2)],
    gearSpeeds: [p.gear2Speed * TPS, p.gear3Speed * TPS],
    maxSpeed: p.maxSpeed * TPS,
    reverseSpeed: Math.max(1.5, p.maxSpeed * TPS * 0.35),
    brakeDecel: p.brakeFriction * 4.5,
    turnIn: p.turnIn,
    turnRatio: p.turnRatio,
    grip: 6.5 * Math.sqrt(Math.max(0.2, p.rearEndStability)),
    skidThreshold: p.skidThreshold * TPS,
    handbrakeSlide: p.handbrakeSlide,
    mass: p.mass,
    antiStrength: p.antiStrength,
  };
}

/** Fallback when a model has no gci entry: style-file quality tiers. */
function fromRating(info: CarInfo): Handling {
  const tier = info.rating >= 21 ? 2 : info.rating >= 11 ? 1 : 0;
  const size = info.h / 64; // length in blocks
  const sizePenalty = Math.max(0, size - 0.9) * 0.8;
  const accel = [4.0, 5.0, 6.2][tier] - sizePenalty;
  return {
    accel: [accel * 0.55, accel * 0.68, accel],
    gearSpeeds: [3.2, 5.4],
    maxSpeed: [7.0, 9.0, 11.5][tier] - sizePenalty,
    reverseSpeed: 2.6,
    brakeDecel: 8,
    turnIn: [0.25, 0.3, 0.38][tier],
    turnRatio: [0.22, 0.3, 0.38][tier],
    grip: 8,
    skidThreshold: 2.6,
    handbrakeSlide: 0.45,
    mass: 14,
    antiStrength: 1,
  };
}

export function handlingFor(info: CarInfo): Handling {
  const p = modelPhysics?.get(info.model);
  return p ? fromPhysics(p) : fromRating(info);
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
  /** sliding beyond the skid threshold this frame (drives skid-mark decals) */
  skidding = false;
  /** brake-to-reverse pause: brief stop before reverse engages (GTA2 feel) */
  private reverseDelay = 0;
  /** current steering deflection -1..1; builds at the model's turn-in rate */
  private steerState = 0;
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

  /** Is world point (x, y) inside the car's oriented box, inflated by r? */
  containsPoint(x: number, y: number, r = 0): boolean {
    const c = Math.cos(this.heading);
    const s = Math.sin(this.heading);
    const dx = x - this.pos.x;
    const dy = y - this.pos.y;
    const lx = dx * c + dy * s;
    const ly = -dx * s + dy * c;
    return Math.abs(lx) < this.length / 2 + r && Math.abs(ly) < this.width / 2 + r;
  }

  /**
   * Two-circle collision model: front and rear circles of radius ~half the
   * car's width, spaced along the heading. Far better fit than one circle.
   */
  collisionCircles(): { x: number; y: number; r: number }[] {
    const c = Math.cos(this.heading);
    const s = Math.sin(this.heading);
    const r = this.width * 0.55;
    const off = Math.max(0, this.length / 2 - r);
    return [
      { x: this.pos.x + c * off, y: this.pos.y + s * off, r },
      { x: this.pos.x - c * off, y: this.pos.y - s * off, r },
    ];
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
    // gear by forward speed (gci shift points)
    const gear = Math.abs(fwd) >= h.gearSpeeds[1] ? 2 : Math.abs(fwd) >= h.gearSpeeds[0] ? 1 : 0;
    if (this.driver) {
      if (throttle > 0) fwd += throttle * h.accel[gear] * dt;
      else if (throttle < 0) {
        if (fwd > 0.15) {
          // braking: stop first, reverse only engages after a short pause
          fwd = Math.max(0, fwd - h.brakeDecel * -throttle * dt);
          this.reverseDelay = 0.3;
        } else if (this.reverseDelay > 0) {
          this.reverseDelay -= dt;
          fwd = Math.max(0, fwd - h.brakeDecel * dt);
        } else {
          fwd += throttle * h.accel[0] * 0.8 * dt; // reversing
        }
      }
      // handbrake locks the wheels: strong longitudinal drag + the slide
      if (handbrake && fwd > 0.1) fwd = Math.max(0, fwd - 7 * dt);
    }
    const drag = this.driver && throttle !== 0 ? 0.25 : 1.4;
    fwd -= fwd * drag * dt;
    if (Math.abs(fwd) < 0.02 && throttle === 0) fwd = 0;
    fwd = Math.min(h.maxSpeed, Math.max(-h.reverseSpeed, fwd));

    // Lateral grip: full below the model's skid threshold, sharply reduced
    // beyond it (tires broken loose); handbrake kills it by handbrakeSlide.
    let grip = h.grip;
    if (Math.abs(lat) > h.skidThreshold) grip *= 0.45;
    if (handbrake) grip *= Math.max(0.08, 1 - h.handbrakeSlide * 1.7);
    lat -= lat * Math.min(1, grip * dt);

    // Tires squeal when sliding beyond the skid threshold at speed.
    this.skidding =
      !!this.driver && Math.abs(lat) > Math.max(0.7, h.skidThreshold * 0.8) && this.speed() > 1.2;
    if (this.skidding) {
      emit({ type: 'skid', pos: { ...this.pos }, intensity: Math.min(1, Math.abs(lat) / 3) });
    }

    // Steering per the original (CarPhysics_B0::UpdateSteeringAngle_562560):
    // the wheel angle is turn_ratio scaled by (0.15 - speed)/0.03 in
    // tiles/tick, clamped at 0.0625 -> full lock when crawling, ~2.08x
    // turn_ratio at speed. Yaw follows a bicycle model; turn_in sets how
    // fast the wheel reaches its target deflection.
    const response = 4 + h.turnIn * 18;
    const dSteer = Math.max(-response * dt, Math.min(response * dt, steer - this.steerState));
    this.steerState = Math.max(-1, Math.min(1, this.steerState + dSteer));
    const vt = Math.min(0.15, Math.abs(fwd) / 30); // tiles/tick
    const angleFactor = Math.max(0.0625, 0.15 - vt) / 0.03; // 2.083 .. 5
    const wheelAngle = Math.min(1.15, h.turnRatio * angleFactor);
    const wheelbase = Math.max(0.5, this.length * 0.75);
    // bicycle-model yaw, limited by what the rear tires can hold (+35%
    // overshoot allowance = the controllable drift window)
    const tireLimit = (1.35 * h.grip * h.skidThreshold) / Math.max(1, Math.abs(fwd));
    const yawRate = Math.min((Math.abs(fwd) / wheelbase) * Math.sin(wheelAngle), tireLimit, 3.6);
    const dir = fwd >= 0 ? 1 : -1;
    const dYaw = this.steerState * yawRate * dir * dt;
    this.heading = wrapAngle(this.heading + dYaw);
    // The velocity does NOT rotate with the car — the world-frame momentum
    // becomes lateral slip in the new car frame, and the tires (grip above)
    // drag it back in line. This is what makes fast corners drift.
    lat -= fwd * dYaw;

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
    // Original cars shrug off most knocks: only solid hits damage, scaled
    // by the model's anti_strength (docs §7).
    if (crashed && impactSpeed > 1.2) {
      if (impactSpeed > 2.4) {
        this.applyDamage(impactSpeed * 1.1 * this.handling.antiStrength, emit);
      }
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

import { Rng } from '../sim/rng';
import { angleDiff, GameEvent, Vec2, dist } from '../sim/types';
import { Car2 } from './car2';
import { CityMap } from './citymap';
import { Ped2 } from './ped2';
import { TrafficAI } from './traffic2';
import { Bullet, WEAPONS } from './weapons2';
import type { Player2 } from './world2';

/**
 * Police, using the decompilation's data (docs/gta2-reference.md §3):
 *  - force escalation models: COPCAR 12 → EDSELFBI 84 → GUNJEEP 22
 *  - cops are ped graphic set 2 (sprite base 316) with remap 0
 *  - crews of 2; health 50 at wanted ≤1, 100 at wanted ≥2
 */
export const COP_CAR_MODEL = 12;
export const FBI_CAR_MODEL = 84;
export const ARMY_JEEP_MODEL = 22;
export const COP_PED_REMAP = 0;
/** cops draw guns at this wanted level (dispatcher table not in the decomp) */
export const COPS_SHOOT_AT = 3;

/** Police vehicle model for the current force level. */
export function policeCarModel(wantedLevel: number): number {
  if (wantedLevel >= 6) return ARMY_JEEP_MODEL;
  if (wantedLevel >= 4) return FBI_CAR_MODEL;
  return COP_CAR_MODEL;
}

const CHASE_SPEED = 2.1;
const ARREST_DIST = 0.42;
const SHOOT_RANGE = 4;
const SHOOT_INTERVAL = 1.1;

/** A police officer: chases the player, arrests on touch, shoots when wanted is high. */
export class Cop extends Ped2 {
  readonly isCop = true;
  /** true briefly after firing — renderer shows the shooting stance */
  shooting = false;
  private shootCooldown = 0;

  constructor(pos: Vec2, z: number, wantedLevel = 1) {
    super(pos, z, COP_PED_REMAP);
    // decomp: 50 hp at wanted 0-1, 100 from wanted 2 (Police_38.cpp:139-222)
    this.health = wantedLevel >= 2 ? 100 : 50;
  }

  /**
   * Chase update; returns 'arrest' when the cop reaches an on-foot player.
   * May push hostile bullets when allowed to shoot.
   */
  updateCop(
    dt: number,
    map: CityMap,
    rng: Rng,
    emit: (e: GameEvent) => void,
    player: Player2,
    wantedLevel: number,
    bullets: Bullet[],
  ): 'arrest' | null {
    if (this.dead) return null;
    this.animTime += dt;
    this.shootCooldown = Math.max(0, this.shootCooldown - dt);
    this.shooting = this.shootCooldown > SHOOT_INTERVAL - 0.35;

    if (this.onFire) {
      // burning cops behave like burning peds
      this.update(dt, map, rng, emit);
      return null;
    }

    const d = dist(this.pos, player.pos);
    this.heading = Math.atan2(player.pos.y - this.pos.y, player.pos.x - this.pos.x);

    // Arrest an on-foot player on contact.
    if (!player.car && !player.dead && d < ARREST_DIST && Math.abs(this.z - player.z) < 1) {
      return 'arrest';
    }

    // Draw guns at high heat.
    if (wantedLevel >= COPS_SHOOT_AT && d < SHOOT_RANGE && this.shootCooldown === 0) {
      const a = this.heading + (rng.next() - 0.5) * 0.12;
      const b = new Bullet(
        { x: this.pos.x + Math.cos(a) * 0.2, y: this.pos.y + Math.sin(a) * 0.2 },
        this.z + 0.5,
        a,
        WEAPONS.pistol,
      );
      b.hostile = true;
      b.pedDamage = 7; // cop fire wounds rather than executes
      bullets.push(b);
      emit({ type: 'shot', weapon: 'pistol', pos: { ...this.pos } });
      this.shootCooldown = SHOOT_INTERVAL;
      // pause to fire
      return null;
    }

    // Run after the player.
    const speed = CHASE_SPEED;
    const nx = this.pos.x + Math.cos(this.heading) * speed * dt;
    const ny = this.pos.y + Math.sin(this.heading) * speed * dt;
    if (map.canMoveBody(this.pos.x, this.pos.y, nx, this.pos.y, this.z, 0.13, 0.6)) this.pos.x = nx;
    if (map.canMoveBody(this.pos.x, this.pos.y, this.pos.x, ny, this.z, 0.13, 0.6)) this.pos.y = ny;
    const g = map.groundZ(this.pos.x, this.pos.y, this.z + 0.55);
    if (g !== null) this.z = g < this.z - 0.05 ? Math.max(g, this.z - 4 * dt) : g;
    return null;
  }
}

/**
 * Cop car pursuit driver: rams a driving player, corners an on-foot one and
 * stops to deploy officers.
 */
export class PursuitAI {
  readonly car: Car2;
  /** seconds until this stopped car may deploy officers again */
  deployCooldown = 0;
  /** lane-follower used while far away — cop cars chase along roads */
  private lane: TrafficAI;
  private stuckTime = 0;
  private reverseTime = 0;

  constructor(car: Car2, dir: ConstructorParameters<typeof TrafficAI>[1]) {
    this.car = car;
    this.lane = new TrafficAI(car, dir);
    this.lane.cruise = 3.0; // sirens on, foot down
    car.driver = 'ai';
  }

  /** Returns 'deploy' when stopped close to the player and ready to unload cops. */
  update(dt: number, player: Player2, map: CityMap, rng: Rng): 'deploy' | null {
    const car = this.car;
    this.deployCooldown = Math.max(0, this.deployCooldown - dt);
    if (car.exploded || car.driver !== 'ai') return null;

    const dx = player.pos.x - car.pos.x;
    const dy = player.pos.y - car.pos.y;
    const d = Math.hypot(dx, dy);

    // Far away: hunt along the road network, junctions biased at the player.
    if (d > 6) {
      this.lane.pursue = player.pos;
      this.lane.update(dt, map, rng, []);
      return null;
    }

    const desired = Math.atan2(dy, dx);
    const diff = angleDiff(car.heading, desired);
    const steer = Math.max(-1, Math.min(1, diff * 2.8));
    const fwd = car.forwardSpeed();

    // Wall-ram recovery: throttling but not moving → back out turning.
    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      car.controls = { throttle: -0.8, steer: -Math.sign(steer || 1), handbrake: false };
      return null;
    }
    if (Math.abs(car.controls.throttle) > 0.3 && car.speed() < 0.25 && d > 2.5) {
      this.stuckTime += dt;
      if (this.stuckTime > 0.6) {
        this.stuckTime = 0;
        this.reverseTime = 0.8;
        return null;
      }
    } else {
      this.stuckTime = 0;
    }

    // Facing badly wrong: three-point turn (reverse while counter-steering).
    if (Math.abs(diff) > 2.1 && d > 1.5) {
      car.controls = { throttle: -0.7, steer: -Math.sign(steer), handbrake: false };
      return null;
    }

    if (!player.car) {
      // Corner an on-foot player: pull up close, stop and bail out.
      if (d < 2.2) {
        car.controls = { throttle: -1, steer, handbrake: false };
        if (Math.abs(fwd) < 0.25 && this.deployCooldown === 0) {
          this.deployCooldown = 5;
          return 'deploy';
        }
        return null;
      }
      car.controls = { throttle: d > 5 ? 0.85 : 0.55, steer, handbrake: false };
      return null;
    }

    // Player driving: ram them.
    car.controls = { throttle: 1, steer, handbrake: false };
    return null;
  }
}

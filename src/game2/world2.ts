import { CarInfo, Sty } from '../gta2/sty';
import { Rng } from '../sim/rng';
import { angleDiff, GameEvent, Vec2, dist } from '../sim/types';
import { Car2 } from './car2';
import { CityMap } from './citymap';
import { panicNearby, Ped2, PED_RADIUS } from './ped2';
import { TrafficAI, dirAngle, dirNameFromArrows } from './traffic2';
import { Bullet, Flame, Inventory, Thrown, WEAPONS } from './weapons2';

export const PLAYER_RADIUS = 0.14;
const WALK_SPEED = 1.8;
const BACK_SPEED = 0.9;
const TURN_RATE = 3.8;
const ENTER_CAR_DIST = 0.95;

const PED_TARGET = 26;
const CAR_TARGET = 12;
const SPAWN_NEAR = 7; // min spawn distance from player (blocks)
const SPAWN_FAR = 15;
const DESPAWN = 22;
const CORPSE_TTL = 15;
const WRECK_TTL = 25;
const PICKUP_RESPAWN = 45;

export interface PlayerInput {
  moveX: number; // steer / rotate
  moveY: number; // -1 = forward/up
  attack: boolean;
  jump: boolean; // edge-triggered
  enterExit: boolean;
  nextWeapon: boolean;
  prevWeapon: boolean;
}

import type { WeaponId } from '../sim/types';

export type PickupKind = Exclude<WeaponId, 'fists'> | 'health';

export interface Pickup {
  pos: Vec2;
  z: number;
  kind: PickupKind;
  respawnIn: number;
}

export interface FirePool {
  pos: Vec2;
  z: number;
  ttl: number;
}

export class Player2 {
  pos: Vec2;
  z: number;
  vz = 0; // vertical velocity (jumping / falling)
  heading = -Math.PI / 2;
  health = 100;
  inventory = new Inventory();
  car: Car2 | null = null;
  score = 0;
  dead = false;
  moving = false;
  animTime = 0;

  constructor(spawn: { x: number; y: number; z: number }) {
    this.pos = { x: spawn.x, y: spawn.y };
    this.z = spawn.z;
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

/**
 * Treat a car as a solid oriented box: if the circle (pos, r) overlaps it,
 * push pos out along the axis of least penetration. Mutates pos.
 */
export function pushOutOfCar(pos: Vec2, r: number, car: Car2): void {
  const c = Math.cos(car.heading);
  const s = Math.sin(car.heading);
  const dx = pos.x - car.pos.x;
  const dy = pos.y - car.pos.y;
  const lx = dx * c + dy * s; // along car length
  const ly = -dx * s + dy * c; // along car width
  const hx = car.length / 2 + r;
  const hy = car.width / 2 + r;
  if (Math.abs(lx) >= hx || Math.abs(ly) >= hy) return;
  let nlx = lx;
  let nly = ly;
  if (hx - Math.abs(lx) < hy - Math.abs(ly)) nlx = Math.sign(lx || 1) * hx;
  else nly = Math.sign(ly || 1) * hy;
  pos.x = car.pos.x + nlx * c - nly * s;
  pos.y = car.pos.y + nlx * s + nly * c;
}

export class World2 {
  readonly map: CityMap;
  readonly sty: Sty;
  readonly rng: Rng;
  /** where the player (re)spawns */
  readonly spawnPoint: { x: number; y: number; z: number };
  player: Player2;
  cars: Car2[] = [];
  drivers: TrafficAI[] = [];
  peds: Ped2[] = [];
  bullets: Bullet[] = [];
  thrown: Thrown[] = [];
  flames: Flame[] = [];
  firePools: FirePool[] = [];
  /** electro beam fired this frame (for rendering) */
  beam: { x0: number; y0: number; x1: number; y1: number; z: number } | null = null;
  pickups: Pickup[] = [];
  events: GameEvent[] = [];
  time = 0;
  private usableCars: CarInfo[];
  private roadSpawns: { x: number; y: number; z: number }[] = [];
  private pavementSpawns: { x: number; y: number; z: number }[] = [];
  private corpseTimers = new Map<number, number>();
  private wreckTimers = new Map<number, number>();
  private repopTimer = 0;
  /** bail-out grace: the car just exited can't run the player over briefly */
  private exitedCar: Car2 | null = null;
  private exitGrace = 0;

  constructor(map: CityMap, sty: Sty, seed = 1999, spawn?: { x: number; y: number }) {
    this.map = map;
    this.sty = sty;
    this.rng = new Rng(seed);
    if (spawn) {
      const z = map.groundZ(spawn.x, spawn.y, 7.9);
      this.spawnPoint = z !== null ? { ...spawn, z } : map.playerSpawn();
    } else {
      this.spawnPoint = map.playerSpawn();
    }
    this.player = new Player2(this.spawnPoint);

    // Cars that make sense as street traffic: normal sized, recyclable.
    this.usableCars = sty.cars.filter((c) => c.rating !== 99 && c.h <= 80 && c.w >= 20);

    const spawns = map.scanSpawns();
    this.roadSpawns = spawns.roads;
    this.pavementSpawns = spawns.pavements;

    this.placePickups();
    for (let i = 0; i < PED_TARGET; i++) this.spawnPed(true);
    for (let i = 0; i < CAR_TARGET; i++) this.spawnTrafficCar(true);
    this.spawnParkedCarNearPlayer();
  }

  private emit = (e: GameEvent): void => {
    this.events.push(e);
  };

  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  // ------------------------------------------------------------- spawning

  private placePickups(): void {
    const kinds: PickupKind[] = [
      'pistol', 'dual_pistol', 'uzi', 's_uzi', 'silenced_s_uzi', 'shotgun',
      'flamethrower', 'electrogun', 'grenade', 'molotov', 'rocket',
      'health', 'health', 'health',
    ];
    const near = this.pavementSpawns
      .filter((s) => dist(s, this.player.pos) < 30)
      .sort((a, b) => dist(a, this.player.pos) - dist(b, this.player.pos));
    for (let i = 0; i < kinds.length && near.length > 0; i++) {
      const s = near[Math.min(near.length - 1, 3 + i * 5)];
      this.pickups.push({ pos: { x: s.x, y: s.y }, z: s.z, kind: kinds[i], respawnIn: 0 });
    }
  }

  private spawnPed(initial = false): void {
    const candidates = this.pavementSpawns.filter((s) => {
      const d = dist(s, this.player.pos);
      return initial ? d < SPAWN_FAR : d > SPAWN_NEAR && d < SPAWN_FAR;
    });
    if (candidates.length === 0) return;
    const s = this.rng.pick(candidates);
    const remapCount = this.sty.palBase.pedRemap;
    const remap = remapCount > 0 ? this.rng.int(0, remapCount) : -1;
    this.peds.push(new Ped2({ x: s.x, y: s.y }, s.z, remap));
  }

  private spawnTrafficCar(initial = false): void {
    const candidates = this.roadSpawns.filter((s) => {
      const d = dist(s, this.player.pos);
      return initial ? d < SPAWN_FAR : d > SPAWN_NEAR && d < SPAWN_FAR;
    });
    if (candidates.length === 0) return;
    const s = this.rng.pick(candidates);
    for (const c of this.cars) {
      if (dist(c.pos, s) < 1.5) return;
    }
    const dir = dirNameFromArrows(this.map.arrowsAt(s.x, s.y, s.z), this.rng);
    if (!dir) return;
    const info = this.rng.pick(this.usableCars);
    const remap = info.remaps.length > 0 ? this.rng.pick(info.remaps) : -1;
    const car = new Car2(info, remap, { x: s.x, y: s.y }, s.z, dirAngle(dir));
    this.cars.push(car);
    this.drivers.push(new TrafficAI(car, dir));
  }

  private spawnParkedCarNearPlayer(): void {
    const near = this.roadSpawns
      .filter((s) => dist(s, this.player.pos) < 14)
      .sort((a, b) => dist(a, this.player.pos) - dist(b, this.player.pos));
    if (near.length === 0) return;
    const s = near[0];
    const info = this.usableCars.find((c) => c.rating >= 11) ?? this.usableCars[0];
    const remap = info.remaps.length > 0 ? this.rng.pick(info.remaps) : -1;
    const dir = dirNameFromArrows(this.map.arrowsAt(s.x, s.y, s.z), this.rng);
    this.cars.push(new Car2(info, remap, { x: s.x, y: s.y }, s.z, dir ? dirAngle(dir) : 0));
  }

  // --------------------------------------------------------------- update

  update(dt: number, input: PlayerInput): void {
    this.time += dt;
    this.exitGrace = Math.max(0, this.exitGrace - dt);
    this.beam = null;
    const player = this.player;
    player.inventory.tick(dt);

    if (!player.dead) {
      if (input.enterExit) this.toggleEnterExit();
      if (input.nextWeapon) player.inventory.cycle(1);
      if (input.prevWeapon) player.inventory.cycle(-1);

      if (player.car) {
        player.car.controls = {
          throttle: -input.moveY,
          steer: input.moveX,
          handbrake: input.attack,
        };
        player.pos = { ...player.car.pos };
        player.z = player.car.z;
        player.heading = player.car.heading;
      } else {
        this.updateOnFoot(dt, input);
        if (input.attack) this.playerAttack();
      }
    }

    const obstacles: Vec2[] = this.cars.filter((c) => !c.exploded).map((c) => c.pos);
    if (!player.car) obstacles.push(player.pos);
    for (const d of this.drivers) {
      d.update(dt, this.map, this.rng, obstacles.filter((p) => p !== d.car.pos));
    }

    for (const car of this.cars) car.update(dt, this.map, this.emit);
    this.bailFromBurningCars();
    this.resolveCarCollisions();
    for (const ped of this.peds) {
      ped.update(dt, this.map, this.rng, this.emit);
      if (ped.dead) continue;
      for (const car of this.cars) {
        // fast cars run peds over (handled below); slow ones are solid
        if (car.speed() < 0.6 && Math.abs(car.z - ped.z) < 0.8) {
          pushOutOfCar(ped.pos, PED_RADIUS, car);
        }
      }
    }
    this.runOverChecks();
    this.updateBullets(dt);
    this.updateThrown(dt);
    this.updateFlames(dt);
    this.updateFirePools(dt);
    this.hornChecks();
    this.updatePickups(dt);
    this.processExplosions();
    this.cleanupAndRepopulate(dt);

    if (player.dead && player.health === 0) {
      player.health = -1;
      this.emit({ type: 'player_died', pos: { ...player.pos } });
    }
  }

  /** GTA2 on-foot controls: left/right rotate, up/down walk along heading. */
  private updateOnFoot(dt: number, input: PlayerInput): void {
    const p = this.player;
    p.heading += input.moveX * TURN_RATE * dt;
    const speed = input.moveY < 0 ? WALK_SPEED : input.moveY > 0 ? -BACK_SPEED : 0;
    p.moving = speed !== 0;
    if (p.moving) p.animTime += dt;
    if (speed !== 0) {
      const nx = p.pos.x + Math.cos(p.heading) * speed * dt;
      const ny = p.pos.y + Math.sin(p.heading) * speed * dt;
      if (this.map.canMoveBody(p.pos.x, p.pos.y, nx, p.pos.y, p.z, PLAYER_RADIUS, 0.6)) p.pos.x = nx;
      if (this.map.canMoveBody(p.pos.x, p.pos.y, p.pos.x, ny, p.z, PLAYER_RADIUS, 0.6)) p.pos.y = ny;
    }

    // Vertical: jump, gravity, ground snap (slopes/steps).
    const ground = this.map.groundZ(p.pos.x, p.pos.y, p.z + 0.55) ?? p.z;
    if (input.jump && p.vz === 0 && p.z - ground <= 0.05) p.vz = 4.3;
    if (p.vz !== 0 || p.z > ground + 0.01) {
      p.vz -= 9.5 * dt;
      p.z += p.vz * dt;
      if (p.z <= ground) {
        p.z = ground;
        p.vz = 0;
      }
    } else {
      p.z = ground;
    }

    // Cars are solid: don't let the player stand inside one.
    for (const car of this.cars) {
      if (Math.abs(car.z - p.z) < 0.8) pushOutOfCar(p.pos, PLAYER_RADIUS, car);
    }
  }

  private toggleEnterExit(): void {
    const player = this.player;
    if (player.car) {
      const car = player.car;
      const side = car.heading - Math.PI / 2;
      const out = {
        x: car.pos.x + Math.cos(side) * (car.width / 2 + PLAYER_RADIUS + 0.12),
        y: car.pos.y + Math.sin(side) * (car.width / 2 + PLAYER_RADIUS + 0.12),
      };
      if (this.map.canMove(car.pos.x, car.pos.y, out.x, out.y, car.z, 0.6)) {
        player.pos = out;
      } else {
        player.pos = { ...car.pos };
      }
      car.driver = null;
      car.controls = { throttle: 0, steer: 0, handbrake: false };
      player.car = null;
      this.exitedCar = car;
      this.exitGrace = 2;
      this.emit({ type: 'car_exit', pos: { ...player.pos } });
      return;
    }
    let best: Car2 | null = null;
    let bestD = ENTER_CAR_DIST;
    for (const car of this.cars) {
      if (car.exploded) continue;
      const d = dist(car.pos, player.pos);
      if (d < bestD && Math.abs(car.z - player.z) < 1) {
        bestD = d;
        best = car;
      }
    }
    if (!best) return;
    this.drivers = this.drivers.filter((d) => d.car !== best);
    best.driver = 'player';
    player.car = best;
    player.pos = { ...best.pos };
    player.z = best.z;
    this.emit({ type: 'car_enter', pos: { ...best.pos } });
  }

  private playerAttack(): void {
    const player = this.player;
    if (!player.inventory.tryFire()) return;
    const def = player.inventory.currentDef();
    if (def.kind !== 'flame' && def.kind !== 'beam') {
      this.emit({ type: 'shot', weapon: def.id, pos: { ...player.pos } });
    }
    const origin = {
      x: player.pos.x + Math.cos(player.heading) * 0.2,
      y: player.pos.y + Math.sin(player.heading) * 0.2,
    };

    switch (def.kind) {
      case 'melee': {
        for (const ped of this.peds) {
          if (ped.dead || Math.abs(ped.z - player.z) > 1) continue;
          if (dist(ped.pos, player.pos) > def.range + PED_RADIUS) continue;
          const a = Math.atan2(ped.pos.y - player.pos.y, ped.pos.x - player.pos.x);
          if (Math.abs(angleDiff(player.heading, a)) < 1.1) {
            ped.applyDamage(def.pedDamage, this.emit, player.pos);
            this.emit({ type: 'hit', pos: { ...ped.pos }, surface: 'ped' });
            if (ped.dead) player.score += 10;
            return;
          }
        }
        return;
      }
      case 'bullet': {
        for (let i = 0; i < def.pellets; i++) {
          const a = player.heading + (this.rng.next() - 0.5) * def.spread;
          // dual pistols fire from two muzzles side by side
          const side = def.pellets === 2 ? (i === 0 ? 0.12 : -0.12) : 0;
          const o = {
            x: origin.x + Math.cos(player.heading + Math.PI / 2) * side,
            y: origin.y + Math.sin(player.heading + Math.PI / 2) * side,
          };
          this.bullets.push(new Bullet(o, player.z + 0.5, a, def));
        }
        panicNearby(this.peds, player.pos, def.silenced ? 0.9 : undefined);
        return;
      }
      case 'rocket': {
        const rocket = new Bullet(origin, player.z + 0.5, player.heading, def);
        rocket.isRocket = true;
        this.bullets.push(rocket);
        panicNearby(this.peds, player.pos);
        return;
      }
      case 'thrown': {
        this.thrown.push(new Thrown(def.id as 'grenade' | 'molotov', origin, player.z, player.heading, def.bulletSpeed));
        return;
      }
      case 'flame': {
        for (let i = 0; i < 2; i++) {
          const a = player.heading + (this.rng.next() - 0.5) * def.spread;
          const speed = def.bulletSpeed * this.rng.range(0.8, 1.15);
          this.flames.push(new Flame(origin, player.z + 0.4, a, speed, def.range / def.bulletSpeed));
        }
        if (this.rng.chance(0.1)) panicNearby(this.peds, player.pos);
        return;
      }
      case 'beam': {
        this.fireBeam(def.range, def.pedDamage, def.carDamage);
        if (this.rng.chance(0.2)) panicNearby(this.peds, player.pos);
        return;
      }
    }
  }

  /** ElectroGun: instant ray that fries the first thing it touches. */
  private fireBeam(range: number, pedDamage: number, carDamage: number): void {
    const p = this.player;
    const step = 0.15;
    const dx = Math.cos(p.heading) * step;
    const dy = Math.sin(p.heading) * step;
    let x = p.pos.x;
    let y = p.pos.y;
    let traveled = 0;
    while (traveled < range) {
      const nx = x + dx;
      const ny = y + dy;
      if (!this.map.canMove(x, y, nx, ny, p.z + 0.5, 2)) break;
      x = nx;
      y = ny;
      traveled += step;
      const ped = this.peds.find((pd) => !pd.dead && Math.abs(pd.z - p.z) < 1 && dist(pd.pos, { x, y }) < PED_RADIUS + 0.12);
      if (ped) {
        ped.applyDamage(pedDamage, this.emit, p.pos);
        if (ped.dead) p.score += 10;
        this.emit({ type: 'hit', pos: { x, y }, surface: 'ped' });
        break;
      }
      const car = this.cars.find((c) => !c.exploded && c !== p.car && Math.abs(c.z - p.z) < 1 && c.containsPoint(x, y, 0.05));
      if (car) {
        car.applyDamage(carDamage * 0.12, this.emit);
        this.emit({ type: 'hit', pos: { x, y }, surface: 'car' });
        break;
      }
    }
    this.beam = { x0: p.pos.x, y0: p.pos.y, x1: x, y1: y, z: p.z + 0.5 };
  }

  /** AI drivers abandon a burning car and flee, like in GTA2. */
  private bailFromBurningCars(): void {
    for (const car of this.cars) {
      if (!car.onFire || car.driver !== 'ai') continue;
      this.drivers = this.drivers.filter((d) => d.car !== car);
      car.driver = null;
      car.controls = { throttle: 0, steer: 0, handbrake: false };
      const side = car.heading - Math.PI / 2;
      const out = {
        x: car.pos.x + Math.cos(side) * (car.width / 2 + PED_RADIUS + 0.1),
        y: car.pos.y + Math.sin(side) * (car.width / 2 + PED_RADIUS + 0.1),
      };
      const remapCount = this.sty.palBase.pedRemap;
      const ped = new Ped2(out, car.z, remapCount > 0 ? this.rng.int(0, remapCount) : -1);
      ped.panic(car.pos);
      this.peds.push(ped);
    }
  }

  private resolveCarCollisions(): void {
    for (let i = 0; i < this.cars.length; i++) {
      const a = this.cars[i];
      if (a.exploded) continue;
      const aCircles = a.collisionCircles();
      for (let j = i + 1; j < this.cars.length; j++) {
        const b = this.cars[j];
        if (b.exploded || Math.abs(a.z - b.z) > 0.8) continue;
        if (dist(a.pos, b.pos) > (a.length + b.length) * 0.6) continue;
        // Two-circle model per car: find the deepest overlapping pair.
        const bCircles = b.collisionCircles();
        let overlap = 0;
        let nx = 0;
        let ny = 0;
        for (const ca of aCircles) {
          for (const cb of bCircles) {
            const dx = cb.x - ca.x;
            const dy = cb.y - ca.y;
            const d = Math.hypot(dx, dy);
            const o = ca.r + cb.r - d;
            if (o > overlap && d > 0) {
              overlap = o;
              nx = dx / d;
              ny = dy / d;
            }
          }
        }
        if (overlap <= 0) continue;
        a.pos.x -= (nx * overlap) / 2;
        a.pos.y -= (ny * overlap) / 2;
        b.pos.x += (nx * overlap) / 2;
        b.pos.y += (ny * overlap) / 2;
        const relSpeed = Math.hypot(a.vel.x - b.vel.x, a.vel.y - b.vel.y);
        if (relSpeed > 1.2) {
          const dmg = relSpeed * 3;
          a.applyDamage(dmg, this.emit);
          b.applyDamage(dmg, this.emit);
          this.emit({
            type: 'car_crash',
            pos: { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 },
            speed: relSpeed,
          });
        }
        const push = 0.3;
        const avx = a.vel.x;
        const avy = a.vel.y;
        a.vel.x += (b.vel.x - avx) * push;
        a.vel.y += (b.vel.y - avy) * push;
        b.vel.x += (avx - b.vel.x) * push;
        b.vel.y += (avy - b.vel.y) * push;
      }
    }
  }

  private runOverChecks(): void {
    for (const car of this.cars) {
      if (car.exploded) continue;
      const speed = car.speed();
      if (speed < 0.6) continue;
      for (const ped of this.peds) {
        if (ped.dead || Math.abs(ped.z - car.z) > 0.8) continue;
        if (car.containsPoint(ped.pos.x, ped.pos.y, PED_RADIUS)) {
          ped.applyDamage(100, this.emit);
          if (car.driver === 'player') this.player.score += 10;
        }
      }
      const p = this.player;
      if (car === this.exitedCar && this.exitGrace > 0) continue;
      if (!p.car && !p.dead && Math.abs(p.z - car.z) < 0.8 && car.containsPoint(p.pos.x, p.pos.y, PLAYER_RADIUS)) {
        p.applyDamage(speed * 14);
        this.emit({ type: 'hit', pos: { ...p.pos } });
      }
    }
  }

  private updateBullets(dt: number): void {
    const survivors: Bullet[] = [];
    for (const b of this.bullets) {
      const ox = b.pos.x;
      const oy = b.pos.y;
      const step = Math.hypot(b.vel.x, b.vel.y) * dt;
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      b.remaining -= step;
      let alive = b.remaining > 0;

      let detonate = false;
      if (alive && !this.map.canMove(ox, oy, b.pos.x, b.pos.y, b.z, 2)) {
        this.emit({ type: 'hit', pos: { ...b.pos }, surface: 'wall' });
        alive = false;
        detonate = true;
      }
      if (alive) {
        for (const ped of this.peds) {
          if (ped.dead || Math.abs(ped.z + 0.5 - b.z) > 0.9) continue;
          if (dist(ped.pos, b.pos) < PED_RADIUS + 0.07) {
            if (!b.isRocket) {
              ped.applyDamage(b.pedDamage, this.emit, { x: ox, y: oy });
              if (ped.dead) this.player.score += 10;
            }
            this.emit({ type: 'hit', pos: { ...b.pos }, surface: 'ped' });
            alive = false;
            detonate = true;
            break;
          }
        }
      }
      if (alive) {
        for (const car of this.cars) {
          if (car.exploded || car === this.player.car || Math.abs(car.z + 0.5 - b.z) > 0.9) continue;
          if (car.containsPoint(b.pos.x, b.pos.y, 0.05)) {
            if (!b.isRocket) {
              car.applyDamage(b.carDamage, this.emit);
            }
            this.emit({ type: 'hit', pos: { ...b.pos }, surface: 'car' });
            alive = false;
            detonate = true;
            break;
          }
        }
      }
      if (!alive || b.remaining <= 0) {
        // rockets explode on impact or at the end of their range
        if (b.isRocket && (detonate || b.remaining <= 0)) {
          this.emit({ type: 'explosion', pos: { ...b.pos } });
        }
      }
      if (alive) survivors.push(b);
    }
    this.bullets = survivors;
  }

  /** Grenades arc, land, and blow after a fuse; molotovs smash into fire pools. */
  private updateThrown(dt: number): void {
    const survivors: Thrown[] = [];
    for (const t of this.thrown) {
      t.fuse -= dt;
      if (!t.landed) {
        const ox = t.pos.x;
        const oy = t.pos.y;
        const nx = t.pos.x + t.vel.x * dt;
        const ny = t.pos.y + t.vel.y * dt;
        if (this.map.canMove(ox, oy, nx, ny, t.z, 2)) {
          t.pos.x = nx;
          t.pos.y = ny;
        } else {
          t.vel.x *= -0.3; // bounce off the wall
          t.vel.y *= -0.3;
        }
        t.vz -= 4.5 * dt;
        t.z += t.vz * dt;
        const ground = this.map.groundZ(t.pos.x, t.pos.y, t.z + 0.5) ?? t.z;
        if (t.z <= ground) {
          t.z = ground;
          if (t.kind === 'molotov') {
            this.emit({ type: 'molotov_smash', pos: { ...t.pos } });
            this.firePools.push({ pos: { ...t.pos }, z: t.z, ttl: 6 });
            continue; // smashed
          }
          t.landed = true;
          t.vel = { x: 0, y: 0 };
        }
      }
      if (t.kind === 'grenade' && t.fuse <= 0) {
        this.emit({ type: 'explosion', pos: { ...t.pos } });
        continue;
      }
      survivors.push(t);
    }
    this.thrown = survivors;
  }

  /** Flamethrower jet particles ignite whatever they touch. */
  private updateFlames(dt: number): void {
    const survivors: Flame[] = [];
    for (const f of this.flames) {
      f.ttl -= dt;
      if (f.ttl <= 0) continue;
      const ox = f.pos.x;
      const oy = f.pos.y;
      f.pos.x += f.vel.x * dt;
      f.pos.y += f.vel.y * dt;
      if (!this.map.canMove(ox, oy, f.pos.x, f.pos.y, f.z, 2)) continue;
      let burned = false;
      for (const ped of this.peds) {
        if (ped.dead || Math.abs(ped.z - f.z) > 1) continue;
        if (dist(ped.pos, f.pos) < PED_RADIUS + 0.15) {
          ped.ignite(this.emit);
          burned = true;
          break;
        }
      }
      if (!burned) {
        for (const car of this.cars) {
          if (car.exploded || car === this.player.car) continue;
          if (Math.abs(car.z - f.z) < 1 && car.containsPoint(f.pos.x, f.pos.y, 0.1)) {
            car.applyDamage(0.8, this.emit);
            burned = true;
            break;
          }
        }
      }
      if (!burned) survivors.push(f);
    }
    this.flames = survivors;
  }

  /** Burning ground (molotovs): cooks everything inside. */
  private updateFirePools(dt: number): void {
    for (const pool of this.firePools) {
      pool.ttl -= dt;
      for (const ped of this.peds) {
        if (!ped.dead && Math.abs(ped.z - pool.z) < 1 && dist(ped.pos, pool.pos) < 0.75) {
          ped.ignite(this.emit);
        }
      }
      for (const car of this.cars) {
        if (!car.exploded && Math.abs(car.z - pool.z) < 1 && dist(car.pos, pool.pos) < 1) {
          car.applyDamage(14 * dt, this.emit);
        }
      }
      const p = this.player;
      if (!p.dead && !p.car && Math.abs(p.z - pool.z) < 1 && dist(p.pos, pool.pos) < 0.7) {
        p.applyDamage(30 * dt);
      }
    }
    this.firePools = this.firePools.filter((p) => p.ttl > 0);
  }

  /** Blocked AI drivers lean on the horn now and then. */
  private hornChecks(): void {
    for (const d of this.drivers) {
      const car = d.car;
      if (car.exploded || car.speed() > 0.3) continue;
      if (car.controls.throttle === -1 && this.rng.chance(0.006)) {
        this.emit({ type: 'horn', pos: { ...car.pos } });
      }
    }
  }

  private updatePickups(dt: number): void {
    for (const p of this.pickups) {
      if (p.respawnIn > 0) {
        p.respawnIn = Math.max(0, p.respawnIn - dt);
        continue;
      }
      if (this.player.dead || this.player.car) continue;
      if (Math.abs(p.z - this.player.z) > 1) continue;
      if (dist(p.pos, this.player.pos) < PLAYER_RADIUS + 0.25) {
        if (p.kind === 'health') {
          this.player.health = Math.min(100, this.player.health + 50);
        } else {
          this.player.inventory.add(p.kind, WEAPONS[p.kind].pickupAmmo);
        }
        p.respawnIn = PICKUP_RESPAWN;
        this.emit({ type: 'pickup', pos: { ...p.pos } });
      }
    }
  }

  private processExplosions(): void {
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i];
      if (e.type !== 'explosion') continue;
      for (const ped of this.peds) {
        if (!ped.dead && dist(ped.pos, e.pos) < 1.2) ped.applyDamage(100, this.emit, e.pos);
      }
      for (const car of this.cars) {
        if (car.exploded) continue;
        const d = dist(car.pos, e.pos);
        // Point blank wrecks outright (rockets one-shot cars in GTA2);
        // the blast fringe batters and usually ignites instead.
        if (d < 0.9) car.applyDamage(150, this.emit, true);
        else if (d < 1.6) car.applyDamage(70, this.emit, true);
      }
      if (!this.player.dead && dist(this.player.pos, e.pos) < 1.4) {
        this.player.applyDamage(this.player.car ? 35 : 60);
      }
      panicNearby(this.peds, e.pos);
    }
  }

  private cleanupAndRepopulate(dt: number): void {
    for (const ped of this.peds) {
      if (!ped.dead) continue;
      this.corpseTimers.set(ped.id, (this.corpseTimers.get(ped.id) ?? CORPSE_TTL) - dt);
    }
    this.peds = this.peds.filter((p) => {
      if (p.dead && (this.corpseTimers.get(p.id) ?? 1) <= 0) return false;
      if (!p.dead && dist(p.pos, this.player.pos) > DESPAWN) return false;
      return true;
    });

    for (const car of this.cars) {
      if (!car.exploded) continue;
      this.wreckTimers.set(car.id, (this.wreckTimers.get(car.id) ?? WRECK_TTL) - dt);
    }
    this.cars = this.cars.filter((c) => {
      if (c.exploded) return (this.wreckTimers.get(c.id) ?? 1) > 0;
      if (c.driver === 'ai' && dist(c.pos, this.player.pos) > DESPAWN) return false;
      return true;
    });
    this.drivers = this.drivers.filter((d) => !d.car.exploded && this.cars.includes(d.car));

    this.repopTimer -= dt;
    if (this.repopTimer <= 0) {
      this.repopTimer = 0.8;
      if (this.peds.filter((p) => !p.dead).length < PED_TARGET) this.spawnPed();
      if (this.cars.filter((c) => !c.exploded && c.driver === 'ai').length < CAR_TARGET) {
        this.spawnTrafficCar();
      }
    }
  }
}

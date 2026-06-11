import { CarInfo, Sty } from '../gta2/sty';
import { Rng } from '../sim/rng';
import { angleDiff, GameEvent, Vec2, dist } from '../sim/types';
import { Car2 } from './car2';
import { CityMap } from './citymap';
import { panicNearby, Ped2, PED_RADIUS } from './ped2';
import { TrafficAI, dirAngle, dirNameFromArrows } from './traffic2';
import { Bullet, Inventory, WEAPONS } from './weapons2';

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

export interface Pickup {
  pos: Vec2;
  z: number;
  kind: 'pistol' | 'uzi' | 'shotgun' | 'health';
  respawnIn: number;
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
    const kinds: Pickup['kind'][] = ['pistol', 'pistol', 'uzi', 'uzi', 'shotgun', 'health', 'health', 'health'];
    const near = this.pavementSpawns
      .filter((s) => dist(s, this.player.pos) < 25)
      .sort((a, b) => dist(a, this.player.pos) - dist(b, this.player.pos));
    for (let i = 0; i < kinds.length && near.length > 0; i++) {
      const s = near[Math.min(near.length - 1, 3 + i * 7)];
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
    this.resolveCarCollisions();
    for (const ped of this.peds) {
      ped.update(dt, this.map, this.rng);
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
    this.emit({ type: 'shot', weapon: def.id, pos: { ...player.pos } });

    if (def.id === 'fists') {
      for (const ped of this.peds) {
        if (ped.dead || Math.abs(ped.z - player.z) > 1) continue;
        if (dist(ped.pos, player.pos) > def.range + PED_RADIUS) continue;
        const a = Math.atan2(ped.pos.y - player.pos.y, ped.pos.x - player.pos.x);
        if (Math.abs(angleDiff(player.heading, a)) < 1.1) {
          ped.applyDamage(def.damage, this.emit, player.pos);
          this.emit({ type: 'hit', pos: { ...ped.pos } });
          if (ped.dead) player.score += 10;
          return;
        }
      }
      return;
    }
    const origin = {
      x: player.pos.x + Math.cos(player.heading) * 0.2,
      y: player.pos.y + Math.sin(player.heading) * 0.2,
    };
    for (let i = 0; i < def.pellets; i++) {
      const a = player.heading + (this.rng.next() - 0.5) * def.spread;
      this.bullets.push(new Bullet(origin, player.z + 0.5, a, def));
    }
    panicNearby(this.peds, player.pos);
  }

  private resolveCarCollisions(): void {
    for (let i = 0; i < this.cars.length; i++) {
      const a = this.cars[i];
      if (a.exploded) continue;
      const ra = a.length * 0.38;
      for (let j = i + 1; j < this.cars.length; j++) {
        const b = this.cars[j];
        if (b.exploded || Math.abs(a.z - b.z) > 0.8) continue;
        const rb = b.length * 0.38;
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const d = Math.hypot(dx, dy);
        const overlap = ra + rb - d;
        if (overlap <= 0 || d === 0) continue;
        const nx = dx / d;
        const ny = dy / d;
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
      const hitR = car.length * 0.45;
      for (const ped of this.peds) {
        if (ped.dead || Math.abs(ped.z - car.z) > 0.8) continue;
        if (dist(ped.pos, car.pos) < hitR + PED_RADIUS) {
          ped.applyDamage(100, this.emit);
          if (car.driver === 'player') this.player.score += 10;
        }
      }
      const p = this.player;
      if (car === this.exitedCar && this.exitGrace > 0) continue;
      if (!p.car && !p.dead && Math.abs(p.z - car.z) < 0.8 && dist(p.pos, car.pos) < hitR + PLAYER_RADIUS) {
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

      if (alive && !this.map.canMove(ox, oy, b.pos.x, b.pos.y, b.z, 2)) {
        this.emit({ type: 'hit', pos: { ...b.pos } });
        alive = false;
      }
      if (alive) {
        for (const ped of this.peds) {
          if (ped.dead || Math.abs(ped.z + 0.5 - b.z) > 0.9) continue;
          if (dist(ped.pos, b.pos) < PED_RADIUS + 0.07) {
            ped.applyDamage(b.damage, this.emit, { x: ox, y: oy });
            if (ped.dead) this.player.score += 10;
            this.emit({ type: 'hit', pos: { ...b.pos } });
            alive = false;
            break;
          }
        }
      }
      if (alive) {
        for (const car of this.cars) {
          if (car.exploded || car === this.player.car || Math.abs(car.z + 0.5 - b.z) > 0.9) continue;
          if (dist(car.pos, b.pos) < car.length * 0.45) {
            car.applyDamage(b.damage, this.emit);
            this.emit({ type: 'hit', pos: { ...b.pos } });
            alive = false;
            break;
          }
        }
      }
      if (alive) survivors.push(b);
    }
    this.bullets = survivors;
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
        if (!car.exploded && dist(car.pos, e.pos) < 1.4) car.applyDamage(60, this.emit);
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

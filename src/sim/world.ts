import { Car, CAR_TYPES } from './car';
import { GameMap, generateDowntown, tileCenter } from './map';
import { panicNearby, Ped, PED_RADIUS } from './ped';
import { Player, PLAYER_RADIUS, PlayerInput } from './player';
import { Rng } from './rng';
import { TrafficDriver } from './traffic';
import { Bullet, WEAPONS } from './weapons';
import { angleDiff, DIR_ANGLE, GameEvent, TILE, Vec2, dist } from './types';

const PED_TARGET = 70;
const CAR_TARGET = 22;
const ENTER_CAR_DIST = 42;
const CORPSE_TTL = 15;
const WRECK_TTL = 25;
const PICKUP_RESPAWN = 30;

export interface Pickup {
  pos: Vec2;
  kind: 'pistol' | 'uzi' | 'shotgun' | 'health';
  /** when > 0 the pickup is collected and waiting to respawn */
  respawnIn: number;
}

export class World {
  readonly map: GameMap;
  readonly rng: Rng;
  player: Player;
  cars: Car[] = [];
  drivers: TrafficDriver[] = [];
  peds: Ped[] = [];
  bullets: Bullet[] = [];
  pickups: Pickup[] = [];
  events: GameEvent[] = [];
  time = 0;
  private corpseTimers = new Map<number, number>();
  private wreckTimers = new Map<number, number>();
  private repopTimer = 0;

  constructor(seed = 1997) {
    this.map = generateDowntown(seed);
    this.rng = new Rng(seed ^ 0xbeef);
    this.player = new Player(this.map.playerSpawn);

    for (const p of this.map.pickups) {
      this.pickups.push({ pos: tileCenter(p.tx, p.ty), kind: p.kind, respawnIn: 0 });
    }

    // Initial population.
    for (let i = 0; i < PED_TARGET; i++) this.spawnPed(0);
    for (const s of this.map.carSpawns.slice(0, CAR_TARGET)) {
      const car = new Car(this.rng.pick(CAR_TYPES), tileCenter(s.tx, s.ty), DIR_ANGLE[s.dir]);
      this.cars.push(car);
      this.drivers.push(new TrafficDriver(car, s.dir));
    }
    this.spawnParkedCarNearPlayer();
  }

  private emit = (e: GameEvent): void => {
    this.events.push(e);
  };

  /** Drain events accumulated since the last call (consumed by audio/vfx). */
  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private spawnPed(minDistFromPlayer: number): void {
    const t = this.rng.pick(this.map.pedSpawnTiles);
    const pos = tileCenter(t.x, t.y);
    if (minDistFromPlayer > 0 && dist(pos, this.player.pos) < minDistFromPlayer) return;
    this.peds.push(new Ped(pos, this.rng.int(0, 6)));
  }

  private spawnParkedCarNearPlayer(): void {
    const px = Math.floor(this.player.pos.x / TILE);
    const py = Math.floor(this.player.pos.y / TILE);
    for (let r = 1; r < 8; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.map.isRoadTile(px + dx, py + dy)) {
            const car = new Car(CAR_TYPES[0], tileCenter(px + dx, py + dy), 0);
            this.cars.push(car);
            return;
          }
        }
      }
    }
  }

  update(dt: number, input: PlayerInput): void {
    this.time += dt;
    const player = this.player;
    player.inventory.tick(dt);

    // --- Player actions ---
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
        player.heading = player.car.heading;
      } else {
        player.updateOnFoot(dt, input, this.map);
        if (input.attack) this.playerAttack();
      }
    }

    // --- Traffic AI ---
    const obstaclePoints: Vec2[] = this.cars.filter((c) => !c.exploded).map((c) => c.pos);
    if (!player.car) obstaclePoints.push(player.pos);
    for (const d of this.drivers) d.update(dt, this.map, this.rng, obstaclePoints.filter((p) => p !== d.car.pos));

    // --- Physics ---
    for (const car of this.cars) car.update(dt, this.map, this.emit);
    this.resolveCarCollisions();
    for (const ped of this.peds) ped.update(dt, this.map, this.rng);
    this.runOverChecks(dt);
    this.updateBullets(dt);
    this.updatePickups(dt);
    this.processExplosions();
    this.cleanupAndRepopulate(dt);

    if (player.dead && player.health === 0) {
      player.health = -1; // emit once
      this.emit({ type: 'player_died', pos: { ...player.pos } });
    }
  }

  // ---------------------------------------------------------------- actions

  private toggleEnterExit(): void {
    const player = this.player;
    if (player.car) {
      // Exit: step out to the car's left side.
      const car = player.car;
      const side = car.heading - Math.PI / 2;
      const out = {
        x: car.pos.x + Math.cos(side) * (car.type.width / 2 + PLAYER_RADIUS + 4),
        y: car.pos.y + Math.sin(side) * (car.type.width / 2 + PLAYER_RADIUS + 4),
      };
      player.pos = this.map.isSolidAt(out.x, out.y) ? { ...car.pos } : out;
      car.driver = null;
      car.controls = { throttle: 0, steer: 0, handbrake: false };
      player.car = null;
      this.emit({ type: 'car_exit', pos: { ...player.pos } });
      return;
    }
    // Enter nearest usable car.
    let best: Car | null = null;
    let bestD = ENTER_CAR_DIST;
    for (const car of this.cars) {
      if (car.exploded) continue;
      const d = dist(car.pos, player.pos);
      if (d < bestD) {
        bestD = d;
        best = car;
      }
    }
    if (!best) return;
    // Carjack: kick out the AI driver.
    this.drivers = this.drivers.filter((d) => d.car !== best);
    best.driver = 'player';
    player.car = best;
    player.pos = { ...best.pos };
    this.emit({ type: 'car_enter', pos: { ...best.pos } });
  }

  private playerAttack(): void {
    const player = this.player;
    if (!player.inventory.tryFire()) return;
    const def = player.inventory.currentDef();
    const origin = {
      x: player.pos.x + Math.cos(player.heading) * 10,
      y: player.pos.y + Math.sin(player.heading) * 10,
    };
    this.emit({ type: 'shot', weapon: def.id, pos: { ...player.pos } });

    if (def.id === 'fists') {
      this.meleeHit(def.range, def.damage);
      return;
    }
    for (let i = 0; i < def.pellets; i++) {
      const a = player.heading + (this.rng.next() - 0.5) * def.spread;
      this.bullets.push(new Bullet(origin, a, def, -1));
    }
    panicNearby(this.peds, player.pos);
  }

  private meleeHit(range: number, damage: number): void {
    const player = this.player;
    for (const ped of this.peds) {
      if (ped.dead) continue;
      if (dist(ped.pos, player.pos) > range + PED_RADIUS) continue;
      const a = Math.atan2(ped.pos.y - player.pos.y, ped.pos.x - player.pos.x);
      if (Math.abs(angleDiff(player.heading, a)) < 1.1) {
        ped.applyDamage(damage, this.emit);
        this.emit({ type: 'hit', pos: { ...ped.pos } });
        if (ped.dead) this.player.score += 10;
        return;
      }
    }
  }

  // ---------------------------------------------------------------- physics

  private resolveCarCollisions(): void {
    for (let i = 0; i < this.cars.length; i++) {
      const a = this.cars[i];
      if (a.exploded) continue;
      const ra = a.type.length * 0.38;
      for (let j = i + 1; j < this.cars.length; j++) {
        const b = this.cars[j];
        if (b.exploded) continue;
        const rb = b.type.length * 0.38;
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
        if (relSpeed > 60) {
          const dmg = relSpeed * 0.06;
          a.applyDamage(dmg, this.emit);
          b.applyDamage(dmg, this.emit);
          this.emit({ type: 'car_crash', pos: { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 }, speed: relSpeed });
        }
        // Swap a bit of momentum so hits feel physical.
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

  private runOverChecks(dt: number): void {
    void dt;
    for (const car of this.cars) {
      if (car.exploded) continue;
      const speed = car.speed();
      if (speed < 30) continue;
      const hitR = car.type.length * 0.45;
      for (const ped of this.peds) {
        if (ped.dead) continue;
        if (dist(ped.pos, car.pos) < hitR + PED_RADIUS) {
          ped.applyDamage(100, this.emit);
          if (car.driver === 'player') this.player.score += 10;
        }
      }
      if (!this.player.car && !this.player.dead && dist(this.player.pos, car.pos) < hitR + PLAYER_RADIUS) {
        this.player.applyDamage(speed * 0.25);
        this.emit({ type: 'hit', pos: { ...this.player.pos } });
      }
    }
  }

  private updateBullets(dt: number): void {
    const survivors: Bullet[] = [];
    for (const b of this.bullets) {
      const step = Math.hypot(b.vel.x, b.vel.y) * dt;
      b.pos.x += b.vel.x * dt;
      b.pos.y += b.vel.y * dt;
      b.remaining -= step;
      let alive = b.remaining > 0;

      if (alive && this.map.isSolidAt(b.pos.x, b.pos.y)) {
        this.emit({ type: 'hit', pos: { ...b.pos } });
        alive = false;
      }
      if (alive) {
        for (const ped of this.peds) {
          if (ped.dead) continue;
          if (dist(ped.pos, b.pos) < PED_RADIUS + 3) {
            ped.applyDamage(b.damage, this.emit);
            if (ped.dead) this.player.score += 10;
            this.emit({ type: 'hit', pos: { ...b.pos } });
            alive = false;
            break;
          }
        }
      }
      if (alive) {
        for (const car of this.cars) {
          if (car.exploded || car === this.player.car) continue;
          if (dist(car.pos, b.pos) < car.type.length * 0.45) {
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
      if (dist(p.pos, this.player.pos) < PLAYER_RADIUS + 10) {
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

  /** Area damage for every explosion event emitted this frame (chains). */
  private processExplosions(): void {
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i];
      if (e.type !== 'explosion') continue;
      for (const ped of this.peds) {
        if (!ped.dead && dist(ped.pos, e.pos) < 70) ped.applyDamage(100, this.emit);
      }
      for (const car of this.cars) {
        if (!car.exploded && dist(car.pos, e.pos) < 80) car.applyDamage(60, this.emit);
      }
      if (!this.player.dead && dist(this.player.pos, e.pos) < 80) {
        this.player.applyDamage(this.player.car ? 35 : 60);
      }
      panicNearby(this.peds, e.pos);
    }
  }

  private cleanupAndRepopulate(dt: number): void {
    // Corpses and wrecks decay.
    for (const ped of this.peds) {
      if (!ped.dead) continue;
      this.corpseTimers.set(ped.id, (this.corpseTimers.get(ped.id) ?? CORPSE_TTL) - dt);
    }
    this.peds = this.peds.filter((p) => !p.dead || (this.corpseTimers.get(p.id) ?? 1) > 0);

    for (const car of this.cars) {
      if (!car.exploded) continue;
      this.wreckTimers.set(car.id, (this.wreckTimers.get(car.id) ?? WRECK_TTL) - dt);
    }
    this.cars = this.cars.filter((c) => {
      if (!c.exploded) return true;
      if ((this.wreckTimers.get(c.id) ?? 1) > 0) return true;
      return false;
    });
    this.drivers = this.drivers.filter((d) => !d.car.exploded && this.cars.includes(d.car));

    // Keep the city alive.
    this.repopTimer -= dt;
    if (this.repopTimer <= 0) {
      this.repopTimer = 1.5;
      if (this.peds.filter((p) => !p.dead).length < PED_TARGET) this.spawnPed(350);
      const activeCars = this.cars.filter((c) => !c.exploded && c.driver === 'ai').length;
      if (activeCars < CAR_TARGET) this.spawnTrafficCar();
    }
  }

  private spawnTrafficCar(): void {
    const s = this.rng.pick(this.map.carSpawns);
    const pos = tileCenter(s.tx, s.ty);
    if (dist(pos, this.player.pos) < 400) return; // out of sight only
    for (const c of this.cars) {
      if (dist(c.pos, pos) < 60) return;
    }
    const car = new Car(this.rng.pick(CAR_TYPES), pos, DIR_ANGLE[s.dir]);
    this.cars.push(car);
    this.drivers.push(new TrafficDriver(car, s.dir));
  }
}

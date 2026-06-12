import { CarInfo, Sty } from '../gta2/sty';
import { Rng } from '../sim/rng';
import { angleDiff, GameEvent, Vec2, dist } from '../sim/types';
import { Car2 } from './car2';
import { CityMap } from './citymap';
import { panicNearby, Ped2, PED_RADIUS } from './ped2';
import { GangId, GangMember, gangTurfs, GangTurf, turfAt } from './gangs';
import { MissionManager } from './missions';
import { Cop, COP_CAR_MODEL, policeCarModel, PursuitAI } from './police';
import { TrafficAI, dirAngle, dirNameFromArrows } from './traffic2';
import { Bullet, Flame, Inventory, Thrown, WEAPONS } from './weapons2';
import { HEAT_PER, Wanted } from './wanted';

export const PLAYER_RADIUS = 0.14;
// authentic player run speed: 0.0625 tiles/tick @ 30fps (docs §8)
const WALK_SPEED = 1.875;
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
  wanted = new Wanted();
  time = 0;
  /** active police pursuits (their cars also live in this.cars) */
  pursuits: PursuitAI[] = [];
  private copCarIds = new Set<number>();
  private policeTimer = 0;
  /** cars recently damaged by the player (for crime attribution) */
  private playerDamaged = new Map<number, number>();
  private heatCounted = new Set<number>();
  private usableCars: CarInfo[];
  private roadSpawns: { x: number; y: number; z: number }[] = [];
  private pavementSpawns: { x: number; y: number; z: number }[] = [];
  private corpseTimers = new Map<number, number>();
  private wreckTimers = new Map<number, number>();
  private repopTimer = 0;
  /** bail-out grace: the car just exited can't run the player over briefly */
  private exitedCar: Car2 | null = null;
  private exitGrace = 0;
  /** seconds until the next roadblock may be thrown up (wanted >= 3) */
  private roadblockTimer = 8;
  /** gang turf rects (ZONE type 14) */
  turfs: GangTurf[] = [];
  /** gang respect: -100 (hated) .. 100 (allied); hostile at <= -20 */
  gangRespect = new Map<GangId, number>();
  /** phone missions */
  missions = new MissionManager();
  /** entity ids exempt from distance despawn (mission targets) */
  private protectedPeds = new Set<number>();
  private protectedCars = new Set<number>();

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

    // Traffic models come from the style file's RECY chunk — the exact list
    // the original game recycles as dummy traffic. Fallback to a heuristic
    // when a style has no usable RECY data.
    const recyclable = new Set(sty.recyclableModels);
    this.usableCars = sty.cars.filter((c) => recyclable.has(c.model));
    if (this.usableCars.length < 4) {
      this.usableCars = sty.cars.filter((c) => c.rating !== 99 && c.h <= 80 && c.w >= 20);
    }

    const spawns = map.scanSpawns();
    this.roadSpawns = spawns.roads;
    this.pavementSpawns = spawns.pavements;
    this.turfs = gangTurfs(map.gmp.zones);

    this.placePickups();
    this.missions.init(this);
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

  /** Score points with the big green world-space popup. */
  private award(amount: number, pos: Vec2, label?: string): void {
    this.player.score += amount;
    this.emit({ type: 'score', pos: { ...pos }, amount, label });
  }

  /** Is this car a police vehicle? (siren light rendering) */
  isCopCar(id: number): boolean {
    return this.copCarIds.has(id);
  }

  /** Mission-system access: pavement spawn spots. */
  pavementSpots(): { x: number; y: number; z: number }[] {
    return this.pavementSpawns;
  }

  /** A spawn spot between min and max blocks from the player. */
  spotAwayFromPlayer(min: number, max: number, kind: 'road' | 'pavement'): { x: number; y: number; z: number } | null {
    const pool = (kind === 'road' ? this.roadSpawns : this.pavementSpawns).filter((s) => {
      const d = dist(s, this.player.pos);
      return d >= min && d <= max;
    });
    return pool.length > 0 ? this.rng.pick(pool) : null;
  }

  /** Spawn a parked despawn-protected car for a mission objective. */
  spawnMissionCar(min: number, max: number): Car2 | null {
    const s = this.spotAwayFromPlayer(min, max, 'road');
    if (!s) return null;
    if (this.cars.some((c) => dist(c.pos, s) < 1.5)) return null;
    const info = this.usableCars.find((c) => c.rating >= 11) ?? this.usableCars[0];
    const remap = info.remaps.length > 0 ? this.rng.pick(info.remaps) : -1;
    const dir = dirNameFromArrows(this.map.arrowsAt(s.x, s.y, s.z), this.rng);
    const car = new Car2(info, remap, { x: s.x, y: s.y }, s.z, dir ? dirAngle(dir) : 0);
    this.cars.push(car);
    this.protectedCars.add(car.id);
    return car;
  }

  /** Exempt a mission ped from distance despawn. */
  protect(ped: Ped2): void {
    this.protectedPeds.add(ped.id);
  }

  /** External event injection (mission system). */
  emitEvent(e: GameEvent): void {
    this.emit(e);
  }

  /** Mission payout: cash + popup. */
  awardMission(reward: number, pos: Vec2): void {
    this.award(reward, pos);
  }

  /** Points + heat for a ped the player killed. */
  private awardKill(ped: Ped2): void {
    this.award(ped.isCop ? 150 : 50, ped.pos);
    this.wanted.add(ped.isCop ? HEAT_PER.copKilled : HEAT_PER.pedKilled);
    // killing a gang member angers them — and pleases their rivals
    if (ped instanceof GangMember) {
      this.changeRespect(ped.gang.id, -15);
      for (const t of this.turfs) {
        if (t.gang.id !== ped.gang.id) this.changeRespect(t.gang.id, 3);
      }
    }
  }

  changeRespect(id: GangId, delta: number): void {
    const v = (this.gangRespect.get(id) ?? 0) + delta;
    this.gangRespect.set(id, Math.max(-100, Math.min(100, v)));
  }

  isGangHostile(id: GangId): boolean {
    return (this.gangRespect.get(id) ?? 0) <= -20;
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
    // inside gang turf, most peds on the street are members in colours
    const turf = turfAt(this.turfs, s);
    if (turf && this.rng.chance(0.55)) {
      this.peds.push(new GangMember({ x: s.x, y: s.y }, s.z, turf.gang));
      return;
    }
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
      .filter((s) => this.cars.every((c) => dist(c.pos, s) > 1.8))
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
    this.wanted.update(dt);
    // Destroying a car you recently shot/burned is a crime — and per the
    // original, any car kill bumps you straight to at least one star.
    for (const car of this.cars) {
      if (!car.exploded || this.heatCounted.has(car.id)) continue;
      const t = this.playerDamaged.get(car.id);
      if (t !== undefined && this.time - t < 6) {
        this.wanted.add(HEAT_PER.carDestroyed, true);
        this.heatCounted.add(car.id);
        const isCopCar = this.copCarIds.has(car.id);
        this.award(isCopCar ? 900 : 200, car.pos, isCopCar ? 'COP CAR CRUSH!' : undefined);
      }
    }
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
      if (ped instanceof Cop) {
        const verdict = ped.updateCop(dt, this.map, this.rng, this.emit, player, this.wanted.level, this.bullets);
        if (verdict === 'arrest') this.bust();
      } else if (ped instanceof GangMember) {
        ped.updateMember(dt, this.map, this.rng, this.emit, player, this.isGangHostile(ped.gang.id), this.bullets);
      } else {
        ped.update(dt, this.map, this.rng, this.emit);
      }
      if (ped.dead) continue;
      for (const car of this.cars) {
        // fast cars run peds over (handled below); slow ones are solid
        if (car.speed() < 0.6 && Math.abs(car.z - ped.z) < 0.8) {
          pushOutOfCar(ped.pos, PED_RADIUS, car);
        }
      }
    }
    this.maintainPolice(dt);
    this.missions.update(dt, this);
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
    const jacked = best.driver === 'ai';
    this.drivers = this.drivers.filter((d) => d.car !== best);
    best.driver = 'player';
    player.car = best;
    player.pos = { ...best.pos };
    player.z = best.z;
    this.emit({ type: 'car_enter', pos: { ...best.pos }, jacked });
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
            if (ped.dead) this.awardKill(ped);
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
        if (ped.dead) this.awardKill(ped);
        this.emit({ type: 'hit', pos: { x, y }, surface: 'ped' });
        break;
      }
      const car = this.cars.find((c) => !c.exploded && c !== p.car && Math.abs(c.z - p.z) < 1 && c.containsPoint(x, y, 0.05));
      if (car) {
        this.playerDamaged.set(car.id, this.time);
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
        // Mass-weighted response (gci): the heavier car shunts the lighter.
        const ma = a.handling.mass;
        const mb = b.handling.mass;
        const aShare = mb / (ma + mb);
        a.pos.x -= nx * overlap * aShare;
        a.pos.y -= ny * overlap * aShare;
        b.pos.x += nx * overlap * (1 - aShare);
        b.pos.y += ny * overlap * (1 - aShare);
        const relSpeed = Math.hypot(a.vel.x - b.vel.x, a.vel.y - b.vel.y);
        if (relSpeed > 1.2) {
          const dmg = relSpeed * 3;
          a.applyDamage(dmg * 2 * aShare, this.emit);
          b.applyDamage(dmg * 2 * (1 - aShare), this.emit);
          this.emit({
            type: 'car_crash',
            pos: { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 },
            speed: relSpeed,
          });
        }
        const push = 0.6;
        const avx = a.vel.x;
        const avy = a.vel.y;
        a.vel.x += (b.vel.x - avx) * push * aShare;
        a.vel.y += (b.vel.y - avy) * push * aShare;
        b.vel.x += (avx - b.vel.x) * push * (1 - aShare);
        b.vel.y += (avy - b.vel.y) * push * (1 - aShare);
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
          if (car.driver === 'player') this.awardKill(ped);
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
      if (alive && b.hostile && !this.player.dead && !this.player.car) {
        // police fire can hit the player
        if (Math.abs(this.player.z + 0.5 - b.z) < 0.9 && dist(this.player.pos, b.pos) < PLAYER_RADIUS + 0.07) {
          this.player.applyDamage(b.pedDamage);
          this.emit({ type: 'hit', pos: { ...b.pos }, surface: 'ped' });
          alive = false;
        }
      }
      if (alive) {
        for (const ped of this.peds) {
          if (ped.dead || Math.abs(ped.z + 0.5 - b.z) > 0.9) continue;
          if (b.hostile && ped.isCop) continue; // cops don't shoot each other
          if (dist(ped.pos, b.pos) < PED_RADIUS + 0.07) {
            if (!b.isRocket) {
              ped.applyDamage(b.pedDamage, this.emit, { x: ox, y: oy });
              if (ped.dead && !b.hostile) this.awardKill(ped);
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
            this.playerDamaged.set(car.id, this.time);
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
            this.playerDamaged.set(car.id, this.time);
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

  /** Spawn/retire police pressure to match the wanted level. */
  private maintainPolice(dt: number): void {
    // Pursuit driving every tick.
    for (const p of this.pursuits) {
      if (p.update(dt, this.player, this.map, this.rng) === 'deploy') this.deployCops(p.car);
    }

    this.policeTimer -= dt;
    if (this.policeTimer > 0) return;
    this.policeTimer = 1;

    const level = this.wanted.level;
    if (level === 0) {
      // Heat gone: pursuits break off and patrol away; cops stop chasing.
      for (const p of this.pursuits) p.car.controls = { throttle: 0, steer: 0, handbrake: false };
      this.pursuits = [];
      // remaining cop cars get cleaned up by the despawn logic below
    }

    // Drop pursuits whose car died.
    this.pursuits = this.pursuits.filter((p) => !p.car.exploded && this.cars.includes(p.car));

    // Cop-car destruction is serious heat (only when the player caused it).
    for (const car of this.cars) {
      if (!this.copCarIds.has(car.id) || !car.exploded || this.heatCounted.has(car.id)) continue;
      const t = this.playerDamaged.get(car.id);
      if (t !== undefined && this.time - t < 6) {
        this.wanted.add(HEAT_PER.copCarDestroyed, true);
        this.heatCounted.add(car.id);
      }
    }

    // Despawn stray cop cars when calm (far away, no pursuit).
    if (level === 0) {
      this.cars = this.cars.filter((c) => {
        if (!this.copCarIds.has(c.id) || c.exploded) return true;
        if (dist(c.pos, this.player.pos) > 10) {
          this.copCarIds.delete(c.id);
          return false;
        }
        return true;
      });
      return;
    }

    // Keep min(level, 4) pursuit cars on the player.
    const activeCopCars = this.pursuits.length;
    const wantCars = Math.min(level, 4);
    if (activeCopCars < wantCars) this.spawnCopCar();

    // GTA2 roadblocks at 3+ stars: cop cars parked across the road ahead
    // of a fleeing driver, officers crouched behind.
    this.roadblockTimer = Math.max(0, this.roadblockTimer - 1);
    if (level >= 3 && this.roadblockTimer === 0 && this.player.car) {
      const v = this.player.car.vel;
      const speed = Math.hypot(v.x, v.y);
      if (speed > 3) {
        const ahead = {
          x: this.player.pos.x + (v.x / speed) * 12,
          y: this.player.pos.y + (v.y / speed) * 12,
        };
        if (this.spawnRoadblock(ahead)) this.roadblockTimer = 18;
      }
    }
  }

  /** Park cop cars across the road near `at`; cops take position behind. */
  private spawnRoadblock(at: Vec2): boolean {
    const info = this.copInfo();
    if (!info) return false;
    const spot = this.roadSpawns
      .filter((s) => dist(s, at) < 3 && dist(s, this.player.pos) > 7)
      .sort((a, b) => dist(a, at) - dist(b, at))[0];
    if (!spot) return false;
    const dir = dirNameFromArrows(this.map.arrowsAt(spot.x, spot.y, spot.z), this.rng);
    if (!dir) return false;
    const road = dirAngle(dir);
    const across = road + Math.PI / 2;
    const cax = Math.cos(across);
    const cay = Math.sin(across);
    let placed = 0;
    for (const off of [-0.85, 0.85]) {
      const cx = spot.x + cax * off;
      const cy = spot.y + cay * off;
      if (!this.map.canMove(spot.x, spot.y, cx, cy, spot.z, 0.6)) continue;
      if (this.cars.some((c) => dist(c.pos, { x: cx, y: cy }) < 1.2)) continue;
      const car = new Car2(info, -1, { x: cx, y: cy }, spot.z, across);
      this.cars.push(car);
      this.copCarIds.add(car.id);
      placed++;
      // officer behind the car, facing the player's approach
      const back = {
        x: cx - Math.cos(road) * (car.width / 2 + 0.3),
        y: cy - Math.sin(road) * (car.width / 2 + 0.3),
      };
      if (this.map.canMove(cx, cy, back.x, back.y, spot.z, 0.6)) {
        this.peds.push(new Cop(back, spot.z, this.wanted.level));
      }
    }
    return placed > 0;
  }

  private copInfo(): CarInfo | null {
    // force escalation: police → FBI cars → army jeeps
    const model = policeCarModel(this.wanted.level);
    return (
      this.sty.cars.find((c) => c.model === model) ??
      this.sty.cars.find((c) => c.model === COP_CAR_MODEL) ??
      null
    );
  }

  private spawnCopCar(): void {
    const info = this.copInfo();
    if (!info) return;
    const candidates = this.roadSpawns.filter((s) => {
      const d = dist(s, this.player.pos);
      return d > 8 && d < 16;
    });
    if (candidates.length === 0) return;
    const s = this.rng.pick(candidates);
    for (const c of this.cars) {
      if (dist(c.pos, s) < 1.5) return;
    }
    // spawn lane-aligned like normal traffic so they start driveable
    const dir = dirNameFromArrows(this.map.arrowsAt(s.x, s.y, s.z), this.rng);
    if (!dir) return;
    const car = new Car2(info, -1, { x: s.x, y: s.y }, s.z, dirAngle(dir));
    this.cars.push(car);
    this.copCarIds.add(car.id);
    this.pursuits.push(new PursuitAI(car, dir));
  }

  /** Two officers bail out of a stopped cop car. */
  private deployCops(car: Car2): void {
    const activeCops = this.peds.filter((p) => p.isCop && !p.dead).length;
    if (activeCops >= Math.min(this.wanted.level * 2, 6)) return;
    for (const side of [car.heading - Math.PI / 2, car.heading + Math.PI / 2]) {
      const out = {
        x: car.pos.x + Math.cos(side) * (car.width / 2 + 0.25),
        y: car.pos.y + Math.sin(side) * (car.width / 2 + 0.25),
      };
      if (!this.map.canMove(car.pos.x, car.pos.y, out.x, out.y, car.z, 0.6)) continue;
      this.peds.push(new Cop(out, car.z, this.wanted.level));
    }
  }

  /** Arrested: BUSTED — weapons confiscated, dropped at the police station. */
  private bust(): void {
    const p = this.player;
    this.emit({ type: 'busted', pos: { ...p.pos } });
    const station = this.map.policeStation() ?? this.spawnPoint;
    p.pos = { x: station.x, y: station.y };
    p.z = station.z;
    p.car = null;
    p.inventory.ammo.clear();
    p.inventory.ammo.set('fists', Infinity);
    p.inventory.current = 'fists';
    this.wanted.clear();
    // pursuit breaks off; officers head back to their day
    this.pursuits = [];
    this.peds = this.peds.filter((ped) => !ped.isCop);
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
        this.emit({ type: 'pickup', pos: { ...p.pos }, kind: p.kind });
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
      if (!p.dead && !this.protectedPeds.has(p.id) && dist(p.pos, this.player.pos) > DESPAWN) return false;
      return true;
    });

    for (const car of this.cars) {
      if (!car.exploded) continue;
      this.wreckTimers.set(car.id, (this.wreckTimers.get(car.id) ?? WRECK_TTL) - dt);
    }
    this.cars = this.cars.filter((c) => {
      if (c.exploded) return this.protectedCars.has(c.id) || (this.wreckTimers.get(c.id) ?? 1) > 0;
      if (c.driver === 'ai' && !this.protectedCars.has(c.id) && dist(c.pos, this.player.pos) > DESPAWN) return false;
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

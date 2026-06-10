import { describe, expect, it } from 'vitest';
import { tileCenter } from '../src/sim/map';
import { Ped } from '../src/sim/ped';
import { PlayerInput } from '../src/sim/player';
import { dist } from '../src/sim/types';
import { WEAPONS } from '../src/sim/weapons';
import { World } from '../src/sim/world';

const DT = 1 / 60;
const SEED = 1997;

function input(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    moveX: 0,
    moveY: 0,
    attack: false,
    enterExit: false,
    nextWeapon: false,
    prevWeapon: false,
    ...overrides,
  };
}

/** Remove ambient actors so bullet/ped tests are fully deterministic. */
function clearActors(world: World): void {
  world.peds.length = 0;
  world.cars.length = 0;
  world.drivers.length = 0;
}

/**
 * A spot on the west (southbound) lane of the vertical road at tx=26 with
 * plenty of clear road to the north — safe for shooting tests.
 */
function clearRoadPos(world: World): { x: number; y: number } {
  const pos = tileCenter(26, 30);
  expect(world.map.isRoadTile(26, 30)).toBe(true);
  expect(world.map.isRoadTile(26, 28)).toBe(true);
  return pos;
}

function nearestCar(world: World) {
  let best = world.cars[0];
  for (const c of world.cars) {
    if (dist(c.pos, world.player.pos) < dist(best.pos, world.player.pos)) best = c;
  }
  return best;
}

describe('World', () => {
  it('constructing spawns peds, cars and pickups', () => {
    const world = new World(SEED);
    expect(world.peds.length).toBeGreaterThan(0);
    expect(world.cars.length).toBeGreaterThan(0);
    expect(world.drivers.length).toBeGreaterThan(0);
    expect(world.pickups).toHaveLength(8);
    expect(world.player.pos).toEqual(world.map.playerSpawn);
    // a parked (driverless) car exists near the player
    const parked = world.cars.filter((c) => c.driver === null);
    expect(parked.length).toBeGreaterThan(0);
  });

  it('runs 300 fixed steps with neutral input without throwing', () => {
    const world = new World(SEED);
    const neutral = input();
    expect(() => {
      for (let i = 0; i < 300; i++) world.update(DT, neutral);
    }).not.toThrow();
    expect(world.time).toBeCloseTo(300 * DT, 5);
    expect(world.player.dead).toBe(false);
  });

  it('enterExit toggles the player in and out of the nearest car', () => {
    const world = new World(SEED);
    const car = nearestCar(world);
    world.player.pos = { ...car.pos }; // walk-up shortcut

    world.update(DT, input({ enterExit: true }));
    expect(world.player.car).toBe(car);
    expect(car.driver).toBe('player');
    let events = world.drainEvents();
    expect(events.some((e) => e.type === 'car_enter')).toBe(true);

    world.update(DT, input()); // key released
    expect(world.player.car).toBe(car);

    world.update(DT, input({ enterExit: true }));
    expect(world.player.car).toBeNull();
    expect(car.driver).toBeNull();
    events = world.drainEvents();
    expect(events.some((e) => e.type === 'car_exit')).toBe(true);
  });

  it('firing the pistol spawns a bullet and emits a shot event', () => {
    const world = new World(SEED);
    clearActors(world);
    world.player.pos = clearRoadPos(world);
    world.player.inventory.add('pistol', 24);

    world.update(DT, input({ attack: true }));

    expect(world.bullets).toHaveLength(1);
    expect(world.player.inventory.currentAmmo()).toBe(23);
    const events = world.drainEvents();
    const shots = events.filter((e) => e.type === 'shot');
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ weapon: 'pistol' });
  });

  it('a pistol bullet kills a ped in front of the player and scores 10', () => {
    const world = new World(SEED);
    clearActors(world);
    const pos = clearRoadPos(world);
    world.player.pos = { ...pos };
    // player default heading is -PI/2 (north); place a weak ped 48u ahead
    const ped = new Ped({ x: pos.x, y: pos.y - 48 }, 0);
    ped.health = 10; // a single 12-damage pistol hit kills
    world.peds.push(ped);
    world.player.inventory.add('pistol', 24);
    expect(world.player.score).toBe(0);

    for (let i = 0; i < 12; i++) world.update(DT, input({ attack: true }));

    expect(ped.dead).toBe(true);
    expect(world.player.score).toBe(10);
    const events = world.drainEvents();
    expect(events.some((e) => e.type === 'ped_killed')).toBe(true);
    expect(events.some((e) => e.type === 'hit')).toBe(true);
    expect(world.bullets).toHaveLength(0); // bullet consumed by the hit
  });

  it('drainEvents returns queued events and clears the queue', () => {
    const world = new World(SEED);
    clearActors(world);
    world.player.pos = clearRoadPos(world);
    world.player.inventory.add('pistol', 24);
    world.update(DT, input({ attack: true }));

    expect(world.events.length).toBeGreaterThan(0);
    const drained = world.drainEvents();
    expect(drained.length).toBeGreaterThan(0);
    expect(world.events).toHaveLength(0);
    expect(world.drainEvents()).toHaveLength(0);
  });

  it('walking over a weapon pickup grants its ammo', () => {
    const world = new World(SEED);
    const pickup = world.pickups.find((p) => p.kind !== 'health');
    expect(pickup).toBeDefined();
    if (!pickup) return;
    const kind = pickup.kind as 'pistol' | 'uzi' | 'shotgun';
    expect(world.player.inventory.has(kind)).toBe(false);

    world.player.pos = { ...pickup.pos };
    world.update(DT, input());

    expect(world.player.inventory.has(kind)).toBe(true);
    expect(world.player.inventory.ammo.get(kind)!).toBeGreaterThanOrEqual(
      WEAPONS[kind].pickupAmmo,
    );
    expect(world.player.inventory.current).toBe(kind);
    expect(pickup.respawnIn).toBeGreaterThan(0);
    const events = world.drainEvents();
    expect(events.some((e) => e.type === 'pickup')).toBe(true);
  });

  it('nextWeapon/prevWeapon inputs cycle the inventory', () => {
    const world = new World(SEED);
    clearActors(world);
    world.player.inventory.add('pistol', 24);
    expect(world.player.inventory.current).toBe('pistol');
    world.update(DT, input({ nextWeapon: true }));
    expect(world.player.inventory.current).toBe('fists');
    world.update(DT, input({ prevWeapon: true }));
    expect(world.player.inventory.current).toBe('pistol');
  });
});

import { describe, expect, it } from 'vitest';
import { Car, CAR_TYPES } from '../src/sim/car';
import { GameMap } from '../src/sim/map';
import { GameEvent, Tile } from '../src/sim/types';

const DT = 1 / 60;
const sedan = CAR_TYPES[0];

/** 40x40 map of pure road (GameMap zero-fills tiles and Tile.Road === 0). */
function openMap(): GameMap {
  return new GameMap(40, 40);
}

function collect(): { events: GameEvent[]; emit: (e: GameEvent) => void } {
  const events: GameEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

describe('Car', () => {
  it('accelerates forward with throttle 1, capped at maxSpeed', () => {
    const map = openMap();
    const { emit } = collect();
    const car = new Car(sedan, { x: 100, y: 640 }, 0);
    car.driver = 'player';
    car.controls = { throttle: 1, steer: 0, handbrake: false };

    let prev = car.forwardSpeed();
    let grew = false;
    for (let i = 0; i < 60 * 4; i++) {
      car.update(DT, map, emit);
      const s = car.forwardSpeed();
      if (s > prev) grew = true;
      expect(s).toBeLessThanOrEqual(sedan.maxSpeed + 1e-6);
      prev = s;
    }
    expect(grew).toBe(true);
    // after 4 seconds at full throttle the sedan should be at its cap
    expect(car.forwardSpeed()).toBeGreaterThan(sedan.maxSpeed * 0.95);
  });

  it('brakes to a stop', () => {
    const map = openMap();
    const { emit } = collect();
    const car = new Car(sedan, { x: 100, y: 640 }, 0);
    car.driver = 'player';

    car.controls = { throttle: 1, steer: 0, handbrake: false };
    for (let i = 0; i < 120; i++) car.update(DT, map, emit);
    const cruising = car.forwardSpeed();
    expect(cruising).toBeGreaterThan(100);

    // brake until almost stopped, then release the pedals and coast to zero
    car.controls = { throttle: -1, steer: 0, handbrake: false };
    let steps = 0;
    while (car.forwardSpeed() > 5 && steps++ < 600) car.update(DT, map, emit);
    expect(car.forwardSpeed()).toBeLessThanOrEqual(5);

    car.controls = { throttle: 0, steer: 0, handbrake: false };
    for (let i = 0; i < 120; i++) car.update(DT, map, emit);
    expect(car.speed()).toBeLessThan(1);
  });

  it('steering does not change heading while stationary', () => {
    const map = openMap();
    const { emit } = collect();
    const car = new Car(sedan, { x: 640, y: 640 }, 0);
    car.driver = 'player';
    car.controls = { throttle: 0, steer: 1, handbrake: false };
    for (let i = 0; i < 60; i++) car.update(DT, map, emit);
    expect(car.heading).toBe(0);
    expect(car.speed()).toBe(0);
  });

  it('steering changes heading while moving', () => {
    const map = openMap();
    const { emit } = collect();
    const car = new Car(sedan, { x: 300, y: 640 }, 0);
    car.driver = 'player';
    car.controls = { throttle: 1, steer: 0, handbrake: false };
    for (let i = 0; i < 60; i++) car.update(DT, map, emit);
    car.controls = { throttle: 1, steer: 1, handbrake: false };
    for (let i = 0; i < 30; i++) car.update(DT, map, emit);
    expect(car.heading).toBeGreaterThan(0.1);
  });

  it('hitting a building at speed stops the car and damages it', () => {
    const map = openMap();
    // wall column at tx = 20 (world x in [640, 672))
    for (let y = 0; y < 40; y++) map.setTile(20, y, Tile.Building);
    const { events, emit } = collect();
    const car = new Car(sedan, { x: 600, y: 640 }, 0);
    car.driver = 'player';
    car.vel = { x: 200, y: 0 };
    car.controls = { throttle: 1, steer: 0, handbrake: false };

    let crashed = false;
    for (let i = 0; i < 60 && !crashed; i++) {
      car.update(DT, map, emit);
      crashed = events.some((e) => e.type === 'car_crash');
    }
    expect(crashed).toBe(true);
    expect(car.health).toBeLessThan(100);
    // the crash kills nearly all forward momentum (small rebound allowed)
    expect(car.forwardSpeed()).toBeLessThan(60);
    // the car never ends up inside the wall
    expect(car.corners().every((p) => !map.isSolidAt(p.x, p.y))).toBe(true);
    expect(car.pos.x).toBeLessThan(640);
  });

  it('slow contact with a wall does not damage the car', () => {
    const map = openMap();
    for (let y = 0; y < 40; y++) map.setTile(20, y, Tile.Building);
    const { events, emit } = collect();
    const car = new Car(sedan, { x: 620, y: 640 }, 0);
    car.driver = 'player';
    car.vel = { x: 20, y: 0 }; // below the 40 u/s damage threshold
    car.controls = { throttle: 0, steer: 0, handbrake: false };
    for (let i = 0; i < 30; i++) car.update(DT, map, emit);
    expect(car.health).toBe(100);
    expect(events.filter((e) => e.type === 'car_crash')).toHaveLength(0);
  });

  it('applyDamage to <= 0 sets exploded and emits explosion exactly once', () => {
    const { events, emit } = collect();
    const car = new Car(sedan, { x: 100, y: 100 }, 0);
    car.applyDamage(40, emit);
    expect(car.exploded).toBe(false);
    expect(events.filter((e) => e.type === 'explosion')).toHaveLength(0);

    car.applyDamage(60, emit); // 100 total -> dead
    expect(car.exploded).toBe(true);
    expect(car.speed()).toBe(0);
    expect(events.filter((e) => e.type === 'explosion')).toHaveLength(1);

    // further damage / updates never emit a second explosion
    car.applyDamage(999, emit);
    car.update(DT, openMap(), emit);
    expect(events.filter((e) => e.type === 'explosion')).toHaveLength(1);
  });
});

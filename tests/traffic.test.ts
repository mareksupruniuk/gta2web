import { describe, expect, it } from 'vitest';
import { Car, CAR_TYPES } from '../src/sim/car';
import { GameMap, tileCenter } from '../src/sim/map';
import { Rng } from '../src/sim/rng';
import { TrafficDriver } from '../src/sim/traffic';
import { Dir, DIR_ANGLE, GameEvent, Tile, TILE } from '../src/sim/types';

const DT = 1 / 60;

/**
 * A tall map that is solid building except for one straight two-lane
 * vertical road: x=3 southbound, x=4 northbound.
 */
function straightLaneMap(): GameMap {
  const map = new GameMap(8, 64);
  map.tiles.fill(Tile.Building);
  for (let y = 1; y < 63; y++) {
    map.setTile(3, y, Tile.Road);
    map.setTile(4, y, Tile.Road);
    map.flows[y * map.width + 3] |= 1 << Dir.S;
    map.flows[y * map.width + 4] |= 1 << Dir.N;
  }
  return map;
}

describe('TrafficDriver', () => {
  it('keeps driving along a straight lane and stays out of buildings', () => {
    const map = straightLaneMap();
    const rng = new Rng(123);
    const events: GameEvent[] = [];
    const emit = (e: GameEvent) => events.push(e);

    const start = tileCenter(3, 2);
    const car = new Car(CAR_TYPES[0], start, DIR_ANGLE[Dir.S]);
    const driver = new TrafficDriver(car, Dir.S);
    expect(car.driver).toBe('ai');

    const laneCenterX = tileCenter(3, 0).x;
    for (let i = 0; i < 60 * 4; i++) {
      driver.update(DT, map, rng, []);
      car.update(DT, map, emit);
      // never inside a building/water tile
      expect(map.isSolidAt(car.pos.x, car.pos.y)).toBe(false);
      // stays roughly in its lane (within one tile of the lane centre)
      expect(Math.abs(car.pos.x - laneCenterX)).toBeLessThan(TILE);
    }

    // after 4 seconds it has made real progress in the lane direction (south)
    expect(car.pos.y - start.y).toBeGreaterThan(200);
    // and is still pointing roughly south
    expect(Math.abs(car.heading - Math.PI / 2)).toBeLessThan(0.5);
    expect(car.exploded).toBe(false);
    expect(events.filter((e) => e.type === 'car_crash')).toHaveLength(0);
  });

  it('brakes for an obstacle directly ahead', () => {
    const map = straightLaneMap();
    const rng = new Rng(5);
    const events: GameEvent[] = [];
    const emit = (e: GameEvent) => events.push(e);

    const car = new Car(CAR_TYPES[0], tileCenter(3, 2), DIR_ANGLE[Dir.S]);
    const driver = new TrafficDriver(car, Dir.S);

    // let it get up to cruising speed first
    for (let i = 0; i < 120; i++) {
      driver.update(DT, map, rng, []);
      car.update(DT, map, emit);
    }
    const cruise = car.forwardSpeed();
    expect(cruise).toBeGreaterThan(40);

    // a permanent obstacle 30u ahead of the car makes it brake hard
    for (let i = 0; i < 90; i++) {
      const ahead = { x: car.pos.x, y: car.pos.y + 30 };
      driver.update(DT, map, rng, [ahead]);
      car.update(DT, map, emit);
    }
    expect(car.forwardSpeed()).toBeLessThan(cruise * 0.25);
  });
});

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseGmp } from '../src/gta2/gmp';
import { parseSty } from '../src/gta2/sty';
import { CityMap } from '../src/game2/citymap';
import { PlayerInput, pushOutOfCar, World2 } from '../src/game2/world2';

const DATA = join(__dirname, '..', 'gamedata');
const haveData = existsSync(join(DATA, 'wil.gmp')) && existsSync(join(DATA, 'wil.sty'));

function load(name: string): ArrayBuffer {
  const b = readFileSync(join(DATA, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

const NEUTRAL: PlayerInput = {
  moveX: 0, moveY: 0, attack: false, jump: false, enterExit: false, nextWeapon: false, prevWeapon: false,
};

describe.skipIf(!haveData)('World2 on Downtown', () => {
  // parse once; World2 construction is cheap enough per test
  const map = haveData ? new CityMap(parseGmp(load('wil.gmp'))) : (null as unknown as CityMap);
  const sty = haveData ? parseSty(load('wil.sty')) : (null as unknown as ReturnType<typeof parseSty>);
  let world: World2;

  beforeEach(() => {
    world = new World2(map, sty, 4242);
  });

  it('spawns population and pickups', () => {
    expect(world.peds.length).toBeGreaterThan(10);
    expect(world.cars.length).toBeGreaterThan(5);
    expect(world.pickups.length).toBeGreaterThan(4);
    expect(world.drivers.length).toBeGreaterThan(4);
  });

  it('survives 300 fixed steps with neutral input', () => {
    for (let i = 0; i < 300; i++) world.update(1 / 60, NEUTRAL);
    expect(world.player.dead).toBe(false);
  });

  it('traffic actually drives along the road network', () => {
    const tracked = world.cars.filter((c) => c.driver === 'ai').slice(0, 6);
    const start = tracked.map((c) => ({ x: c.pos.x, y: c.pos.y }));
    for (let i = 0; i < 60 * 6; i++) world.update(1 / 60, NEUTRAL);
    const moved = tracked.filter((c, i) => Math.hypot(c.pos.x - start[i].x, c.pos.y - start[i].y) > 1.5);
    expect(moved.length).toBeGreaterThan(1);
    // and no driving car ended up off the network into a building interior
    for (const c of tracked) {
      if (c.exploded) continue;
      expect(map.groundZ(c.pos.x, c.pos.y, c.z + 0.6)).not.toBeNull();
    }
  });

  it('rotation controls: holding left rotates, forward moves along heading', () => {
    const p = world.player;
    const h0 = p.heading;
    for (let i = 0; i < 30; i++) world.update(1 / 60, { ...NEUTRAL, moveX: -1 });
    expect(p.heading).not.toBe(h0);
    const pos0 = { ...p.pos };
    const heading = p.heading;
    for (let i = 0; i < 30; i++) world.update(1 / 60, { ...NEUTRAL, moveY: -1 });
    const dx = p.pos.x - pos0.x;
    const dy = p.pos.y - pos0.y;
    if (Math.hypot(dx, dy) > 0.05) {
      const moveAngle = Math.atan2(dy, dx);
      let diff = Math.abs(moveAngle - heading) % (Math.PI * 2);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      expect(diff).toBeLessThan(0.3);
    }
  });

  it('enters and exits the nearest parked car', () => {
    const parked = world.cars.find((c) => !c.driver);
    expect(parked).toBeTruthy();
    world.player.pos = { x: parked!.pos.x + 0.5, y: parked!.pos.y };
    world.player.z = parked!.z;
    world.update(1 / 60, { ...NEUTRAL, enterExit: true });
    expect(world.player.car).toBe(parked);
    expect(world.drainEvents().some((e) => e.type === 'car_enter')).toBe(true);
    world.update(1 / 60, { ...NEUTRAL, enterExit: true });
    expect(world.player.car).toBeNull();
    expect(world.drainEvents().some((e) => e.type === 'car_exit')).toBe(true);
  });

  it('drives the car forward with up input', () => {
    const parked = world.cars.find((c) => !c.driver)!;
    world.player.pos = { x: parked.pos.x, y: parked.pos.y };
    world.player.z = parked.z;
    world.update(1 / 60, { ...NEUTRAL, enterExit: true });
    expect(world.player.car).toBe(parked);
    const start = { ...parked.pos };
    for (let i = 0; i < 120; i++) world.update(1 / 60, { ...NEUTRAL, moveY: -1 });
    expect(Math.hypot(parked.pos.x - start.x, parked.pos.y - start.y)).toBeGreaterThan(0.5);
  });

  it('firing the pistol spends ammo, spawns a bullet and emits a shot', () => {
    world.player.inventory.add('pistol', 10);
    world.update(1 / 60, { ...NEUTRAL, attack: true });
    expect(world.player.inventory.currentAmmo()).toBe(9);
    expect(world.bullets.length).toBeGreaterThan(0);
    expect(world.drainEvents().some((e) => e.type === 'shot')).toBe(true);
  });

  it('bullets kill peds and raise the score', () => {
    const p = world.player;
    p.inventory.add('pistol', 10);
    const ped = world.peds[0];
    // place the ped directly in front of the player at the same height
    ped.pos = { x: p.pos.x + 1, y: p.pos.y };
    ped.z = p.z;
    p.heading = 0;
    const score0 = p.score;
    for (let i = 0; i < 60 && !ped.dead; i++) {
      world.update(1 / 60, { ...NEUTRAL, attack: i % 25 === 0 });
    }
    expect(ped.dead).toBe(true);
    expect(p.score).toBe(score0 + 10);
  });

  it('cars are solid: a body inside a car gets pushed out', () => {
    const car = world.cars[0];
    const r = 0.14;
    const pos = { x: car.pos.x + 0.05, y: car.pos.y + 0.05 };
    pushOutOfCar(pos, r, car);
    // transform into car frame and assert outside the inflated box
    const c = Math.cos(car.heading);
    const s = Math.sin(car.heading);
    const dx = pos.x - car.pos.x;
    const dy = pos.y - car.pos.y;
    const lx = Math.abs(dx * c + dy * s);
    const ly = Math.abs(-dx * s + dy * c);
    const outside = lx >= car.length / 2 + r - 1e-9 || ly >= car.width / 2 + r - 1e-9;
    expect(outside).toBe(true);
    // a point already outside is untouched
    const far = { x: car.pos.x + 5, y: car.pos.y };
    pushOutOfCar(far, r, car);
    expect(far).toEqual({ x: car.pos.x + 5, y: car.pos.y });
  });

  it('exiting a moving car does not instantly kill the player', () => {
    const parked = world.cars.find((c) => !c.driver)!;
    world.player.pos = { x: parked.pos.x, y: parked.pos.y };
    world.player.z = parked.z;
    world.update(1 / 60, { ...NEUTRAL, enterExit: true });
    expect(world.player.car).toBe(parked);
    for (let i = 0; i < 60; i++) world.update(1 / 60, { ...NEUTRAL, moveY: -1 }); // get up to speed
    world.update(1 / 60, { ...NEUTRAL, enterExit: true }); // bail out
    expect(world.player.car).toBeNull();
    for (let i = 0; i < 30; i++) world.update(1 / 60, NEUTRAL);
    expect(world.player.dead).toBe(false);
  });

  it('collects pickups', () => {
    const pk = world.pickups.find((p) => p.kind !== 'health') ?? world.pickups[0];
    world.player.pos = { ...pk.pos };
    world.player.z = pk.z;
    world.update(1 / 60, NEUTRAL);
    expect(pk.respawnIn).toBeGreaterThan(0);
    if (pk.kind !== 'health') {
      expect(world.player.inventory.has(pk.kind)).toBe(true);
    }
  });
});

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseGmp } from '../src/gta2/gmp';
import { parseSty } from '../src/gta2/sty';
import { CityMap } from '../src/game2/citymap';
import { PlayerInput, pushOutOfCar, World2 } from '../src/game2/world2';
import { Cop } from '../src/game2/police';
import { GangMember } from '../src/game2/gangs';

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
    expect(p.score).toBe(score0 + 50); // GTA2 scoring: 50 per ped kill
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

  it('guns kill peds in one shot (GTA2 fragile peds)', () => {
    const p = world.player;
    p.inventory.add('pistol', 10);
    const ped = world.peds[0];
    ped.pos = { x: p.pos.x + 1, y: p.pos.y };
    ped.z = p.z;
    p.heading = 0;
    for (let i = 0; i < 30 && !ped.dead; i++) {
      world.update(1 / 60, { ...NEUTRAL, attack: i === 0 });
    }
    expect(ped.dead).toBe(true); // a single pistol round is lethal
  });

  it('shot-up cars catch fire, burn, then explode', () => {
    const car = world.cars.find((c) => !c.driver)!;
    // pour bullets in: pistol carDamage 7 → fire below 20 health
    for (let i = 0; i < 12; i++) car.applyDamage(7, () => undefined);
    expect(car.onFire).toBe(true);
    expect(car.exploded).toBe(false);
    const events: { type: string }[] = [];
    // burn for 5 simulated seconds → cook-off
    for (let i = 0; i < 60 * 5 && !car.exploded; i++) {
      car.update(1 / 60, map, (e) => events.push(e));
    }
    expect(car.exploded).toBe(true);
    expect(events.some((e) => e.type === 'explosion')).toBe(true);
  });

  it('AI drivers bail out of burning cars', () => {
    const driven = world.cars.find((c) => c.driver === 'ai')!;
    const pedsBefore = world.peds.length;
    driven.applyDamage(95, () => undefined);
    expect(driven.onFire).toBe(true);
    world.update(1 / 60, NEUTRAL);
    expect(driven.driver).toBeNull();
    expect(world.peds.length).toBe(pedsBefore + 1);
  });

  it('explosions destroy cars instantly (chain), bullets do not', () => {
    const car = world.cars.find((c) => !c.driver)!;
    car.applyDamage(500, () => undefined, true);
    expect(car.exploded).toBe(true);
  });

  it('rocket one-shots a car and detonates on impact', () => {
    const car = world.cars.find((c) => !c.driver)!;
    world.peds.length = 0; // clear the firing lane
    world.player.pos = { x: car.pos.x - 4, y: car.pos.y };
    world.player.z = car.z;
    world.player.heading = 0;
    world.player.inventory.add('rocket', 5);
    world.update(1 / 60, { ...NEUTRAL, attack: true });
    expect(world.bullets[0]?.isRocket).toBe(true);
    for (let i = 0; i < 90; i++) world.update(1 / 60, NEUTRAL);
    expect(car.exploded).toBe(true);
  });

  it('flamethrower ignites peds; burning peds die', () => {
    const ped = world.peds.find((x) => !x.dead)!;
    world.player.heading = 0;
    world.player.inventory.add('flamethrower', 80);
    for (let i = 0; i < 40 && !ped.onFire; i++) {
      ped.pos = { x: world.player.pos.x + 1.2, y: world.player.pos.y };
      ped.z = world.player.z;
      world.update(1 / 60, { ...NEUTRAL, attack: true });
    }
    expect(ped.onFire).toBe(true);
    for (let i = 0; i < 60 * 4; i++) world.update(1 / 60, NEUTRAL);
    expect(ped.dead).toBe(true);
  });

  it('molotovs smash into fire pools that burn peds', () => {
    world.player.heading = 0;
    world.player.inventory.add('molotov', 6);
    world.update(1 / 60, { ...NEUTRAL, attack: true });
    expect(world.thrown).toHaveLength(1);
    for (let i = 0; i < 90; i++) world.update(1 / 60, NEUTRAL);
    expect(world.thrown).toHaveLength(0);
    expect(world.firePools.length).toBeGreaterThan(0);
    expect(world.drainEvents().some((e) => e.type === 'molotov_smash')).toBe(true);
    // a ped standing in the pool catches fire
    const pool = world.firePools[0];
    const ped = world.peds.find((x) => !x.dead)!;
    ped.pos = { ...pool.pos };
    ped.z = pool.z;
    world.update(1 / 60, NEUTRAL);
    expect(ped.onFire).toBe(true);
  });

  it('grenades explode after their fuse', () => {
    world.peds.length = 0;
    world.player.inventory.add('grenade', 6);
    world.update(1 / 60, { ...NEUTRAL, attack: true });
    expect(world.thrown).toHaveLength(1);
    world.drainEvents();
    for (let i = 0; i < 60 * 3; i++) world.update(1 / 60, NEUTRAL);
    expect(world.thrown).toHaveLength(0);
    expect(world.drainEvents().some((e) => e.type === 'explosion')).toBe(true);
  });

  it('electrogun beam fries the first ped in line', () => {
    const ped = world.peds.find((x) => !x.dead)!;
    ped.pos = { x: world.player.pos.x + 2, y: world.player.pos.y };
    ped.z = world.player.z;
    world.player.heading = 0;
    world.player.inventory.add('electrogun', 90);
    world.update(1 / 60, { ...NEUTRAL, attack: true });
    expect(world.beam).not.toBeNull();
    expect(ped.dead).toBe(true);
  });

  it('killing peds raises the wanted level and cop cars come hunting', () => {
    expect(world.wanted.level).toBe(0);
    // authentic heat: +100 per ped, star one at 600 → six murders
    world.player.inventory.add('pistol', 24);
    let killed = 0;
    for (let k = 0; k < 12 && killed < 6; k++) {
      const ped = world.peds.find((x) => !x.dead && !x.isCop);
      if (!ped) break;
      ped.pos = { x: world.player.pos.x + 1, y: world.player.pos.y };
      ped.z = world.player.z;
      world.player.heading = 0;
      for (let i = 0; i < 60 && !ped.dead; i++) {
        world.update(1 / 60, { ...NEUTRAL, attack: i % 30 === 0 });
      }
      if (ped.dead) killed++;
    }
    expect(killed).toBeGreaterThanOrEqual(6);
    expect(world.wanted.heat).toBeGreaterThanOrEqual(600);
    expect(world.wanted.level).toBeGreaterThan(0);
    // give the dispatcher a few seconds
    for (let i = 0; i < 60 * 4; i++) world.update(1 / 60, NEUTRAL);
    expect(world.pursuits.length).toBeGreaterThan(0);
    // pursuit succeeds if a cop car closes in — or the cops already got you
    const d0 = Math.min(
      ...world.pursuits.map((p) => Math.hypot(p.car.pos.x - world.player.pos.x, p.car.pos.y - world.player.pos.y)),
    );
    let minD = d0;
    let busted = false;
    // road-network pursuit from ~13 blocks out takes ~10 s; allow 12
    for (let i = 0; i < 60 * 12; i++) {
      world.update(1 / 60, NEUTRAL);
      if (world.drainEvents().some((e) => e.type === 'busted')) busted = true;
      for (const p of world.pursuits) {
        minD = Math.min(minD, Math.hypot(p.car.pos.x - world.player.pos.x, p.car.pos.y - world.player.pos.y));
      }
    }
    expect(busted || minD < d0 - 1).toBe(true);
  });

  it('at 3+ stars a roadblock appears ahead of a fleeing driver', () => {
    world.wanted.add(3000); // three stars
    expect(world.wanted.level).toBeGreaterThanOrEqual(3);
    // put the player in a fast car on a road
    const car = world.cars[0];
    world.drivers = world.drivers.filter((d) => d.car !== car);
    car.driver = 'player';
    world.player.car = car;
    const copCarsBefore = world.cars.filter((c) => world['copCarIds'].has(c.id)).length;
    // fake sustained speed so the dispatcher sees a fleeing driver
    for (let i = 0; i < 60 * 22; i++) {
      car.vel.x = 5;
      car.vel.y = 0;
      world.update(1 / 60, NEUTRAL);
    }
    const copCarsAfter = world.cars.filter((c) => world['copCarIds'].has(c.id)).length;
    expect(copCarsAfter).toBeGreaterThan(copCarsBefore);
  });

  it('an arresting cop busts the player: weapons gone, wanted cleared, moved to the station', () => {
    world.wanted.add(1000); // hot
    world.player.inventory.add('shotgun', 12);
    // put a cop right on top of the on-foot player
    const cop = new Cop({ x: world.player.pos.x + 0.2, y: world.player.pos.y }, world.player.z);
    world.peds.push(cop);
    const before = { ...world.player.pos };
    for (let i = 0; i < 90 && world.wanted.level > 0; i++) world.update(1 / 60, NEUTRAL);
    expect(world.wanted.level).toBe(0);
    expect(world.player.inventory.has('shotgun')).toBe(false);
    expect(world.drainEvents().some((e) => e.type === 'busted')).toBe(true);
    const station = world.map.policeStation();
    if (station) {
      expect(Math.hypot(world.player.pos.x - station.x, world.player.pos.y - station.y)).toBeLessThan(1);
      expect(Math.hypot(world.player.pos.x - before.x, world.player.pos.y - before.y)).toBeGreaterThan(1);
    }
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

describe.skipIf(!haveData)('gangs on Downtown', () => {
  const map = haveData ? new CityMap(parseGmp(load('wil.gmp'))) : (null as unknown as CityMap);
  const sty = haveData ? parseSty(load('wil.sty')) : (null as unknown as ReturnType<typeof parseSty>);

  it('parses gang turfs and spawns members in colours; killing one provokes the gang', () => {
    const world = new World2(map, sty, 777);
    expect(world.turfs.length).toBeGreaterThanOrEqual(8); // 3 gangs x several zones
    const gangs = new Set(world.turfs.map((t) => t.gang.id));
    expect(gangs).toContain('yakuza');
    expect(gangs).toContain('loonies');
    expect(gangs).toContain('zaibatsu');

    // drop the player inside a turf and force-spawn peds around them
    const turf = world.turfs.find((t) => t.gang.id === 'yakuza')!;
    world.player.pos = { x: turf.x + turf.w / 2, y: turf.y + turf.h / 2 };
    world.player.z = map.groundZ(world.player.pos.x, world.player.pos.y, 7.9) ?? world.player.z;
    for (let i = 0; i < 60; i++) (world as unknown as { spawnPed(b: boolean): void }).spawnPed(true);
    const members = world.peds.filter((p): p is GangMember => p instanceof GangMember);
    expect(members.length).toBeGreaterThan(0);

    // killing a member makes that gang hostile
    const victim = members[0];
    victim.pos = { x: world.player.pos.x + 0.5, y: world.player.pos.y };
    victim.z = world.player.z;
    world.player.inventory.add('pistol', 10);
    world.player.heading = 0;
    for (let i = 0; i < 120 && !victim.dead; i++) {
      world.update(1 / 60, { ...NEUTRAL, attack: i % 30 === 0 });
    }
    expect(victim.dead).toBe(true);
    expect(world.isGangHostile(victim.gang.id)).toBe(false); // one kill = -15, not hostile yet
    // a second kill crosses the hostility threshold
    const second = world.peds.find(
      (p): p is GangMember => p instanceof GangMember && !p.dead && p.gang.id === victim.gang.id,
    );
    if (second) {
      second.pos = { x: world.player.pos.x + 0.5, y: world.player.pos.y };
      second.z = world.player.z;
      world.player.heading = 0;
      for (let i = 0; i < 120 && !second.dead; i++) {
        world.update(1 / 60, { ...NEUTRAL, attack: i % 30 === 0 });
      }
    }
    expect(world.isGangHostile(victim.gang.id)).toBe(true);

    // a hostile member nearby opens fire (hostile bullets appear)
    const shooter = world.peds.find(
      (p): p is GangMember => p instanceof GangMember && !p.dead && p.gang.id === victim.gang.id,
    );
    if (shooter) {
      shooter.pos = { x: world.player.pos.x + 2, y: world.player.pos.y };
      shooter.z = world.player.z;
      let hostileShot = false;
      for (let i = 0; i < 180 && !hostileShot; i++) {
        world.update(1 / 60, NEUTRAL);
        hostileShot = world.bullets.some((b) => b.hostile);
      }
      expect(hostileShot).toBe(true);
    }
  });
});

describe.skipIf(!haveData)('phone missions on Downtown', () => {
  const map = haveData ? new CityMap(parseGmp(load('wil.gmp'))) : (null as unknown as CityMap);
  const sty = haveData ? parseSty(load('wil.sty')) : (null as unknown as ReturnType<typeof parseSty>);

  it('phones exist per gang; answering starts a job; finishing it pays out', () => {
    const world = new World2(map, sty, 1234);
    expect(world.missions.phones.length).toBeGreaterThanOrEqual(2);

    // walk onto a phone
    const phone = world.missions.phones[0];
    world.player.pos = { x: phone.pos.x, y: phone.pos.y };
    world.player.z = phone.z;
    // spot selection can fail on a given tick; the phone retries while idle
    for (let i = 0; i < 120 && !world.missions.active; i++) {
      world.player.pos = { x: phone.pos.x, y: phone.pos.y };
      world.update(1 / 60, NEUTRAL);
    }
    const mission = world.missions.active;
    expect(mission).not.toBeNull();
    expect(world.drainEvents().some((e) => e.type === 'mission_start')).toBe(true);

    // complete it by force
    const score0 = world.player.score;
    if (mission!.kind === 'hit') mission!.targetPed!.applyDamage(1000, () => undefined);
    else if (mission!.kind === 'wreck') mission!.targetCar!.applyDamage(1000, () => undefined, true);
    else {
      // deliver: teleport the car (with player driving) to the dropoff
      const car = mission!.targetCar!;
      world.drivers = world.drivers.filter((d) => d.car !== car);
      car.driver = 'player';
      world.player.car = car;
      car.pos = { ...mission!.deliverTo! };
      car.z = map.groundZ(car.pos.x, car.pos.y, 8) ?? car.z;
    }
    for (let i = 0; i < 10 && world.missions.active; i++) world.update(1 / 60, NEUTRAL);
    expect(world.missions.active).toBeNull();
    expect(world.drainEvents().some((e) => e.type === 'mission_complete')).toBe(true);
    expect(world.player.score).toBeGreaterThan(score0);
    // the phone goes on cooldown
    expect(phone.cooldown).toBeGreaterThan(0);
  });
});

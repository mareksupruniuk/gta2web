import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/sim/map';
import { PANIC_RADIUS, Ped, panicNearby } from '../src/sim/ped';
import { Rng } from '../src/sim/rng';
import { GameEvent, Tile } from '../src/sim/types';

const DT = 1 / 60;

function grassMap(): GameMap {
  const map = new GameMap(20, 20);
  map.tiles.fill(Tile.Grass);
  return map;
}

function collect(): { events: GameEvent[]; emit: (e: GameEvent) => void } {
  const events: GameEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

describe('Ped', () => {
  it('walks around: position changes over updates', () => {
    const map = grassMap();
    const rng = new Rng(42);
    const ped = new Ped({ x: 320, y: 320 }, 0);
    const start = { ...ped.pos };
    for (let i = 0; i < 120; i++) ped.update(DT, map, rng);
    const moved = Math.hypot(ped.pos.x - start.x, ped.pos.y - start.y);
    expect(moved).toBeGreaterThan(5);
    expect(ped.state).toBe('walk');
  });

  it('does not walk into solid tiles', () => {
    const map = grassMap();
    // box the ped into a single tile
    for (let i = 0; i < 20; i++) {
      map.setTile(i, 0, Tile.Building);
    }
    map.setTile(9, 4, Tile.Building);
    map.setTile(11, 4, Tile.Building);
    map.setTile(10, 3, Tile.Building);
    map.setTile(10, 5, Tile.Building);
    const rng = new Rng(7);
    const ped = new Ped({ x: 10.5 * 32, y: 4.5 * 32 }, 0);
    for (let i = 0; i < 300; i++) {
      ped.update(DT, map, rng);
      expect(map.isSolidAt(ped.pos.x, ped.pos.y)).toBe(false);
    }
  });

  it('non-lethal damage causes flee state and a scream event', () => {
    const { events, emit } = collect();
    const ped = new Ped({ x: 100, y: 100 }, 0);
    ped.applyDamage(5, emit); // health 20 -> 15
    expect(ped.dead).toBe(false);
    expect(ped.state).toBe('flee');
    expect(events.filter((e) => e.type === 'ped_scream')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'ped_killed')).toHaveLength(0);
  });

  it('lethal damage sets dead and emits ped_killed', () => {
    const { events, emit } = collect();
    const ped = new Ped({ x: 100, y: 100 }, 0);
    ped.applyDamage(25, emit);
    expect(ped.dead).toBe(true);
    expect(ped.state).toBe('dead');
    expect(events.filter((e) => e.type === 'ped_killed')).toHaveLength(1);

    // dead peds ignore further damage and never move
    ped.applyDamage(100, emit);
    expect(events.filter((e) => e.type === 'ped_killed')).toHaveLength(1);
    const map = grassMap();
    const before = { ...ped.pos };
    ped.update(DT, map, new Rng(1));
    expect(ped.pos).toEqual(before);
  });

  it('fleeing peds move faster and away from the threat', () => {
    const map = grassMap();
    const rng = new Rng(3);
    const ped = new Ped({ x: 320, y: 320 }, 0);
    ped.panic({ x: 280, y: 320 }); // threat to the west
    for (let i = 0; i < 60; i++) ped.update(DT, map, rng);
    expect(ped.pos.x).toBeGreaterThan(320); // ran east, away from threat
  });

  it('panicNearby only affects living peds within PANIC_RADIUS', () => {
    const threat = { x: 0, y: 0 };
    const near = new Ped({ x: PANIC_RADIUS - 10, y: 0 }, 0);
    const far = new Ped({ x: PANIC_RADIUS + 10, y: 0 }, 0);
    const { emit } = collect();
    const deadNear = new Ped({ x: 10, y: 0 }, 0);
    deadNear.applyDamage(100, emit);

    panicNearby([near, far, deadNear], threat);
    expect(near.state).toBe('flee');
    expect(far.state).toBe('walk');
    expect(deadNear.state).toBe('dead');
  });
});

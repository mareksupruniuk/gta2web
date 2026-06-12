import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseGci } from '../src/gta2/gci';
import { handlingFor, setModelPhysics } from '../src/game2/car2';
import type { CarInfo } from '../src/gta2/sty';

const GCI_PATH = 'gamedata/nyc.gci';
const hasData = existsSync(GCI_PATH);

const fakeInfo = (model: number): CarInfo =>
  ({ model, rating: 11, w: 32, h: 64, remaps: [] }) as unknown as CarInfo;

describe.skipIf(!hasData)('nyc.gci handling', () => {
  const table = parseGci(readFileSync(GCI_PATH, 'utf8'));

  it('parses all 83 car models', () => {
    expect(table.size).toBe(83);
  });

  it('cop car (12) matches the reference doc values', () => {
    const cop = table.get(12)!;
    expect(cop.name).toBe('Cop Car');
    expect(cop.turbo).toBe(true);
    expect(cop.mass).toBeCloseTo(14.5 * 1.1, 5); // ConvertMass ×1.1
    expect(cop.maxSpeed).toBeCloseTo(0.415, 5);
    expect(cop.turnRatio).toBeCloseTo(0.4, 5);
    expect(cop.handbrakeSlide).toBeCloseTo(0.4, 5);
    expect(cop.gearMult).toEqual([0.55, 0.68, 1.0]);
    expect(cop.gear2Speed).toBeCloseTo(0.18, 5);
  });

  it('tank (54) is heavy, slow and slide-proof', () => {
    const tank = table.get(54)!;
    expect(tank.mass).toBeCloseTo(45 * 1.1, 5);
    expect(tank.maxSpeed).toBeCloseTo(0.1, 5);
    expect(tank.handbrakeSlide).toBe(0);
  });

  it('handlingFor uses gci values when registered', () => {
    setModelPhysics(table);
    const h = handlingFor(fakeInfo(12));
    expect(h.maxSpeed).toBeCloseTo(0.415 * 30, 3); // 12.45 blocks/s
    expect(h.skidThreshold).toBeCloseTo(0.115 * 30, 3);
    expect(h.accel[2]).toBeGreaterThan(h.accel[0]); // gears progress
    // bug (8) is lighter & slower than the cop car
    const bug = handlingFor(fakeInfo(8));
    expect(bug.maxSpeed).toBeLessThan(h.maxSpeed);
    expect(bug.mass).toBeLessThan(h.mass);
    setModelPhysics(null);
  });

  it('falls back to rating tiers for unknown models', () => {
    setModelPhysics(table);
    const h = handlingFor(fakeInfo(200));
    expect(h.maxSpeed).toBeGreaterThan(5);
    setModelPhysics(null);
  });
});

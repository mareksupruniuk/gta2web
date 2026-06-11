import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseGmp, GroundType } from '../src/gta2/gmp';
import { CityMap } from '../src/game2/citymap';

const DATA = join(__dirname, '..', 'gamedata');
const haveData = existsSync(join(DATA, 'wil.gmp'));

function loadMap(): CityMap {
  const b = readFileSync(join(DATA, 'wil.gmp'));
  return new CityMap(parseGmp(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)));
}

describe.skipIf(!haveData)('CityMap on Downtown (wil.gmp)', () => {
  const map = haveData ? loadMap() : (null as unknown as CityMap);

  it('finds a player spawn on solid ground', () => {
    const s = map.playerSpawn();
    expect(s.z).toBeGreaterThan(0);
    const g = map.groundZ(s.x, s.y, s.z);
    expect(g).not.toBeNull();
    expect(Math.abs((g ?? 0) - s.z)).toBeLessThan(0.01);
  });

  it('scans thousands of road and pavement spawn points', () => {
    const s = map.scanSpawns();
    expect(s.roads.length).toBeGreaterThan(1000);
    expect(s.pavements.length).toBeGreaterThan(1000);
    // road spawns carry usable arrow data
    const withDirs = s.roads.filter((r) => r.arrows.north || r.arrows.south || r.arrows.east || r.arrows.west);
    expect(withDirs.length).toBeGreaterThan(500);
  });

  it('road spawn blocks really are road ground type', () => {
    const s = map.scanSpawns();
    for (const r of s.roads.slice(0, 200)) {
      expect(map.groundTypeAt(r.x, r.y, r.z)).toBe(GroundType.Road);
    }
  });

  it('allows movement along a road and blocks movement into buildings eventually', () => {
    const s = map.scanSpawns();
    const r = s.roads[Math.floor(s.roads.length / 2)];
    // moving a tiny step on flat road must be allowed
    expect(map.canMove(r.x, r.y, r.x + 0.05, r.y, r.z)).toBe(true);
    // walking in a straight line for 300 blocks must hit a wall/void at some
    // point on this island map
    let x = r.x;
    let blockedSomewhere = false;
    for (let i = 0; i < 3000; i++) {
      if (!map.canMove(x, r.y, x + 0.1, r.y, r.z)) {
        blockedSomewhere = true;
        break;
      }
      x += 0.1;
    }
    expect(blockedSomewhere).toBe(true);
  });

  it('lets entities pass under bridges: groundZ ignores decks above headroom', () => {
    // find a column with two stacked walkable surfaces (street + bridge deck)
    const gmp = map.gmp;
    let found = 0;
    for (let y = 2; y < 254 && found < 5; y++) {
      for (let x = 2; x < 254 && found < 5; x++) {
        const col = gmp.getColumn(x, y);
        const lids: number[] = [];
        for (let i = 0; i < col.blockIds.length; i++) {
          const b = gmp.blocks[col.blockIds[i]];
          if (b && (b.lid & 0x3ff) !== 0 && b.slopeByte >> 2 !== 63) lids.push(col.offset + i + 1);
        }
        if (lids.length < 2) continue;
        const low = lids[0];
        const high = lids[lids.length - 1];
        if (high - low < 2) continue; // need headroom between street and deck
        found++;
        // an entity at street level must see the street, not the deck above
        const gLow = map.groundZ(x + 0.5, y + 0.5, low + 0.55);
        expect(gLow).toBe(low);
        // an entity on the deck sees the deck
        const gHigh = map.groundZ(x + 0.5, y + 0.5, high + 0.55);
        expect(gHigh).toBe(high);
      }
    }
    expect(found).toBeGreaterThan(0); // Downtown has bridges/viaducts
  });

  it('has restart zones and navigation areas', () => {
    expect(map.zonesOfType(16).length).toBeGreaterThan(0);
    const s = map.playerSpawn();
    expect(map.areaName(s.x, s.y)).toBeTruthy();
  });

  it('ground height interpolates smoothly across a slope somewhere', () => {
    // find a slope block (slope type 1-44) and check heights vary within it
    const gmp = map.gmp;
    outer: for (let y = 0; y < 256; y += 1) {
      for (let x = 0; x < 256; x += 1) {
        const col = gmp.getColumn(x, y);
        for (let i = 0; i < col.blockIds.length; i++) {
          const b = gmp.blocks[col.blockIds[i]];
          const slope = b.slopeByte >> 2;
          if (slope >= 1 && slope <= 44 && (b.lid & 0x3ff) !== 0) {
            const z = col.offset + i + 1.2;
            const g1 = map.groundZ(x + 0.1, y + 0.1, z);
            const g2 = map.groundZ(x + 0.9, y + 0.9, z);
            expect(g1).not.toBeNull();
            expect(g2).not.toBeNull();
            expect(g1).not.toBe(g2); // sloped, so corners differ
            break outer;
          }
        }
      }
    }
  });
});

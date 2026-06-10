import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseGmp, decodeLid, groundType, GroundType, MAP_SIZE } from '../src/gta2/gmp';
import { parseSty, TILE_SIZE } from '../src/gta2/sty';
import { buildTileAtlas } from '../src/gta2/atlas';
import { buildChunkGeometry, computeTransparentTiles } from '../src/gta2/citymesh';
import { slopeCorners, slopeHeightAt } from '../src/gta2/slopes';

const DATA = join(__dirname, '..', 'gamedata');
const haveData = existsSync(join(DATA, 'bil.gmp')) && existsSync(join(DATA, 'bil.sty'));

function load(name: string): ArrayBuffer {
  const b = readFileSync(join(DATA, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

describe('slopes (pure)', () => {
  it('flat block has all corners at 1', () => {
    expect(slopeCorners(0)).toEqual({ nw: 1, ne: 1, sw: 1, se: 1 });
  });
  it('45° up slope rises toward north', () => {
    const c = slopeCorners(41);
    expect(c.nw).toBe(1);
    expect(c.ne).toBe(1);
    expect(c.sw).toBe(0);
    expect(c.se).toBe(0);
  });
  it('26° low piece spans 0..0.5', () => {
    const c = slopeCorners(1);
    expect(c.sw).toBe(0);
    expect(c.nw).toBe(0.5);
  });
  it('interpolates heights bilinearly', () => {
    expect(slopeHeightAt(41, 0.5, 0)).toBe(1);
    expect(slopeHeightAt(41, 0.5, 1)).toBe(0);
    expect(slopeHeightAt(41, 0.5, 0.5)).toBe(0.5);
    expect(slopeHeightAt(0, 0.3, 0.7)).toBe(1);
  });
});

describe.skipIf(!haveData)('bil.gmp (real data)', () => {
  it('parses with sane structure', () => {
    const gmp = parseGmp(load('bil.gmp'));
    expect(gmp.base.length).toBe(MAP_SIZE * MAP_SIZE);
    expect(gmp.blocks.length).toBeGreaterThan(1000);
    // every base offset points inside columnWords
    for (let i = 0; i < gmp.base.length; i++) {
      expect(gmp.base[i]).toBeLessThan(gmp.columnWords.length);
    }
  });

  it('columns reference valid blocks and have sane heights', () => {
    const gmp = parseGmp(load('bil.gmp'));
    for (let y = 0; y < MAP_SIZE; y += 7) {
      for (let x = 0; x < MAP_SIZE; x += 7) {
        const col = gmp.getColumn(x, y);
        expect(col.height).toBeLessThanOrEqual(8);
        expect(col.offset).toBeLessThanOrEqual(col.height);
        for (const id of col.blockIds) {
          expect(id).toBeLessThan(gmp.blocks.length);
        }
      }
    }
  });

  it('the city contains road and pavement ground blocks', () => {
    const gmp = parseGmp(load('bil.gmp'));
    let road = 0;
    let pavement = 0;
    let lids = 0;
    for (let y = 0; y < MAP_SIZE; y += 2) {
      for (let x = 0; x < MAP_SIZE; x += 2) {
        const col = gmp.getColumn(x, y);
        for (let i = 0; i < col.blockIds.length; i++) {
          const b = gmp.blocks[col.blockIds[i]];
          if (decodeLid(b.lid).tile !== 0) lids++;
          const g = groundType(b);
          if (g === GroundType.Road) road++;
          if (g === GroundType.Pavement) pavement++;
        }
      }
    }
    expect(lids).toBeGreaterThan(2000);
    expect(road).toBeGreaterThan(500);
    expect(pavement).toBeGreaterThan(500);
  });
});

describe.skipIf(!haveData)('bil.sty (real data)', () => {
  it('parses with sane structure', () => {
    const sty = parseSty(load('bil.sty'));
    expect(sty.tileCount).toBeGreaterThanOrEqual(992);
    expect(sty.sprites.length).toBeGreaterThan(300);
    expect(sty.cars.length).toBeGreaterThan(30);
    expect(sty.palx.length).toBe(16384);
    // car sprite dims are sane
    for (const car of sty.cars) {
      expect(car.w).toBeGreaterThan(0);
      expect(car.h).toBeGreaterThan(0);
    }
    // sprite entries point inside SPRG
    for (const s of sty.sprites) {
      expect(s.ptr).toBeLessThan(sty.spriteData.length);
    }
  });

  it('decodes tiles to non-uniform RGBA (palettes actually apply)', () => {
    const sty = parseSty(load('bil.sty'));
    let nonBlank = 0;
    for (let t = 0; t < 64; t++) {
      const rgba = sty.tileRGBA(t);
      expect(rgba.length).toBe(TILE_SIZE * TILE_SIZE * 4);
      const first = rgba[0] | (rgba[1] << 8) | (rgba[2] << 16);
      for (let i = 0; i < rgba.length; i += 4) {
        const v = rgba[i] | (rgba[i + 1] << 8) | (rgba[i + 2] << 16);
        if (v !== first) {
          nonBlank++;
          break;
        }
      }
    }
    expect(nonBlank).toBeGreaterThan(32); // most tiles have varied pixels
  });

  it('builds the atlas and chunk geometry', () => {
    const sty = parseSty(load('bil.sty'));
    const gmp = parseGmp(load('bil.gmp'));
    const atlas = buildTileAtlas(sty);
    expect(atlas.size).toBe(2048);
    const transparent = computeTransparentTiles(sty);
    const geo = buildChunkGeometry(gmp, atlas, transparent, 7, 7);
    const quads = (geo.solid.indices.length + geo.cutout.indices.length) / 6;
    expect(quads).toBeGreaterThan(100); // city centre chunk is busy
    expect(geo.solid.positions.length % 3).toBe(0);
    expect(geo.solid.uvs.length / 2).toBe(geo.solid.positions.length / 3);
  });
});

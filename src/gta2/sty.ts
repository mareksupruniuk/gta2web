import { BinReader, readChunkedFile } from './reader';

/**
 * GTA2 style file (.sty, "GBST" version 700): tile graphics, sprite graphics,
 * palettes and car metadata. All images are 8bpp indexed into per-image
 * palettes resolved via PALB (virtual palette bases) + PALX (virtual →
 * physical palette index) + PPAL (physical palette pages).
 */

const PAGE = 256; // graphics pages are 256x256 bytes
export const TILE_SIZE = 64;

export interface SpriteEntry {
  ptr: number; // byte offset into SPRG
  w: number;
  h: number;
}

export interface CarInfo {
  model: number;
  /**
   * In the file this stores only how many sprites the car adds (0 or 1; 0 =
   * shares the previous car's graphic). spriteIdx below is the resolved
   * absolute sprite number.
   */
  sprite: number;
  spriteIdx: number;
  w: number; // size in pixels (64 px = 1 block)
  h: number;
  passengers: number;
  wreck: number;
  rating: number;
  remaps: number[];
}

export interface PaletteBase {
  tile: number;
  sprite: number;
  carRemap: number;
  pedRemap: number;
  codeObjRemap: number;
  mapObjRemap: number;
  userRemap: number;
  fontRemap: number;
}

export interface SpriteDelta {
  /** byte stream of {u16 pageOffset, u8 len, data[len]} records */
  data: Uint8Array;
}

export class Sty {
  version!: number;
  tileData!: Uint8Array; // raw TILE chunk (pages)
  spriteData!: Uint8Array; // raw SPRG chunk (pages)
  palx!: Uint16Array; // 16384 virtual → physical
  ppal!: Uint8Array; // raw physical palette pages (BGRA)
  palBase!: PaletteBase;
  sprites!: SpriteEntry[];
  spriteBase!: { car: number; ped: number; codeObj: number; mapObj: number; user: number; font: number };
  /** cumulative sprite offsets of each font within the font section (FONB) */
  fontBases: number[] = [];
  cars!: CarInfo[];
  /** car models eligible for traffic recycling (RECY chunk) */
  recyclableModels: number[] = [];
  /** sprite deltas (damage overlays etc.), keyed by sprite number */
  deltas = new Map<number, SpriteDelta[]>();

  get tileCount(): number {
    return (this.tileData.length / (PAGE * PAGE)) * 16;
  }

  /** Physical palette index for a virtual palette number. */
  physPalette(virtual: number): number {
    return this.palx[virtual];
  }

  /** RGBA color (Uint8Array[4]) for color index c of physical palette p. */
  color(phys: number, c: number, out: Uint8Array, outOff: number): void {
    // 64 palettes per page, stored as dword columns: dword index within a
    // page for (color c, palette p) is c*64 + p. Stored byte order is BGRA.
    const page = phys >> 6;
    const p = phys & 63;
    const off = page * 64 * 256 * 4 + (c * 64 + p) * 4;
    out[outOff] = this.ppal[off + 2]; // R
    out[outOff + 1] = this.ppal[off + 1]; // G
    out[outOff + 2] = this.ppal[off]; // B
    out[outOff + 3] = c === 0 ? 0 : 255; // index 0 is transparent
  }

  /** 8bpp pixel of tile t at (x, y). Tiles are 64x64, 16 per 256x256 page. */
  tilePixel(t: number, x: number, y: number): number {
    const pageIdx = t >> 4;
    const i = t & 15;
    const tx = (i & 3) * TILE_SIZE;
    const ty = (i >> 2) * TILE_SIZE;
    return this.tileData[pageIdx * PAGE * PAGE + (ty + y) * PAGE + tx + x];
  }

  /** Decode tile t to RGBA (64*64*4 bytes). */
  tileRGBA(t: number): Uint8Array {
    const out = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    const phys = this.physPalette(t); // tiles use virtual palettes 0..tileCount-1
    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        const c = this.tilePixel(t, x, y);
        this.color(phys, c, out, (y * TILE_SIZE + x) * 4);
      }
    }
    return out;
  }

  /**
   * Decode sprite s to RGBA. remap: physical palette override (e.g. car
   * colour remaps); when omitted the sprite's own virtual palette is used.
   * deltaIndices: which of the sprite's deltas (damage dents, lights...) to
   * composite on top, in order.
   */
  spriteRGBA(s: number, remapPhys?: number, deltaIndices?: number[]): { w: number; h: number; data: Uint8Array } {
    const e = this.sprites[s];
    const phys = remapPhys ?? this.physPalette(this.palBase.tile + s);
    const out = new Uint8Array(e.w * e.h * 4);
    const pageIdx = Math.floor(e.ptr / (PAGE * PAGE));
    const ofs = e.ptr % (PAGE * PAGE);
    const sx = ofs % PAGE;
    const sy = Math.floor(ofs / PAGE);

    // 8bpp working copy of the sprite rect so deltas can patch it.
    const indexed = new Uint8Array(e.w * e.h);
    for (let y = 0; y < e.h; y++) {
      for (let x = 0; x < e.w; x++) {
        indexed[y * e.w + x] = this.spriteData[pageIdx * PAGE * PAGE + (sy + y) * PAGE + sx + x];
      }
    }
    if (deltaIndices && deltaIndices.length > 0) {
      const list = this.deltas.get(s) ?? [];
      for (const di of deltaIndices) {
        const d = list[di];
        if (d) applyDelta(indexed, e.w, e.h, d.data);
      }
    }

    for (let i = 0; i < indexed.length; i++) {
      this.color(phys, indexed[i], out, i * 4);
    }
    return { w: e.w, h: e.h, data: out };
  }

  /** Physical palette for car remap r (use in spriteRGBA). */
  carRemapPalette(r: number): number {
    return this.physPalette(this.palBase.tile + this.palBase.sprite + r);
  }

  /** Physical palette for ped remap r. */
  pedRemapPalette(r: number): number {
    return this.physPalette(this.palBase.tile + this.palBase.sprite + this.palBase.carRemap + r);
  }
}

/**
 * Composite a delta onto an 8bpp sprite rect. The delta is a stream of
 * {u16 offset, u8 len, data[len]} records; offsets accumulate from the
 * sprite's top-left and are measured in 256-px page rows (per the style
 * doc), so x = pos % 256, y = pos >> 8 within the sprite.
 */
function applyDelta(indexed: Uint8Array, w: number, h: number, data: Uint8Array): void {
  let pos = 0;
  let p = 0;
  while (p + 3 <= data.length) {
    pos += data[p] | (data[p + 1] << 8);
    const len = data[p + 2];
    p += 3;
    const x = pos % PAGE;
    const y = Math.floor(pos / PAGE);
    for (let i = 0; i < len && p + i < data.length; i++) {
      if (x + i < w && y < h) indexed[y * w + x + i] = data[p + i];
    }
    p += len;
    pos += len;
  }
}

export function parseSty(buffer: ArrayBuffer): Sty {
  const { version, chunks } = readChunkedFile(buffer, 'GBST');
  if (version !== 700) throw new Error(`unsupported STY version ${version}`);
  const sty = new Sty();
  sty.version = version;

  const need = (name: string) => {
    const c = chunks.get(name);
    if (!c) throw new Error(`STY missing chunk ${name}`);
    return c;
  };

  const tile = need('TILE');
  sty.tileData = new Uint8Array(buffer, tile.offset, tile.size);

  const sprg = need('SPRG');
  sty.spriteData = new Uint8Array(buffer, sprg.offset, sprg.size);

  const palx = need('PALX');
  sty.palx = new Uint16Array(buffer.slice(palx.offset, palx.offset + palx.size));

  const ppal = need('PPAL');
  sty.ppal = new Uint8Array(buffer, ppal.offset, ppal.size);

  {
    const r = new BinReader(buffer, need('PALB').offset);
    sty.palBase = {
      tile: r.u16(),
      sprite: r.u16(),
      carRemap: r.u16(),
      pedRemap: r.u16(),
      codeObjRemap: r.u16(),
      mapObjRemap: r.u16(),
      userRemap: r.u16(),
      fontRemap: r.u16(),
    };
  }

  {
    const r = new BinReader(buffer, need('SPRB').offset);
    sty.spriteBase = {
      car: r.u16(),
      ped: r.u16(),
      codeObj: r.u16(),
      mapObj: r.u16(),
      user: r.u16(),
      font: r.u16(),
    };
  }

  {
    const fonb = chunks.get('FONB');
    if (fonb) {
      const r = new BinReader(buffer, fonb.offset, fonb.size);
      const count = r.u16();
      let acc = 0;
      for (let i = 0; i < count; i++) {
        sty.fontBases.push(acc);
        acc += r.u16();
      }
    }
  }

  {
    const sprx = need('SPRX');
    const r = new BinReader(buffer, sprx.offset, sprx.size);
    const n = sprx.size / 8;
    sty.sprites = [];
    for (let i = 0; i < n; i++) {
      const ptr = r.u32();
      const w = r.u8();
      const h = r.u8();
      r.skip(2); // pad
      sty.sprites.push({ ptr, w, h });
    }
  }

  {
    const cari = need('CARI');
    const r = new BinReader(buffer, cari.offset, cari.size);
    sty.cars = [];
    while (r.pos + 15 <= cari.size) {
      const model = r.u8();
      const sprite = r.u8();
      const w = r.u8();
      const h = r.u8();
      const numRemaps = r.u8();
      const passengers = r.u8();
      const wreck = r.u8();
      const rating = r.u8();
      r.skip(6); // front/rear wheel + window offsets (4 x i8), info_flags x2
      const remaps: number[] = [];
      for (let i = 0; i < numRemaps; i++) remaps.push(r.u8());
      const numDoors = r.u8();
      r.skip(numDoors * 2);
      // `sprite` in the file is a 0/1 sprite count; resolve the absolute
      // sprite index by accumulating (car sprites start at base 0).
      const prev = sty.cars[sty.cars.length - 1];
      const spriteIdx = prev ? prev.spriteIdx + prev.sprite : 0;
      sty.cars.push({ model, sprite, spriteIdx, w, h, passengers, wreck, rating, remaps });
    }
    if (r.pos !== cari.size) {
      throw new Error(`CARI parse mismatch: ended at ${r.pos} of ${cari.size}`);
    }
  }

  // RECY: car models eligible for traffic recycling (255-terminated bytes).
  const recy = chunks.get('RECY');
  if (recy) {
    const r = new BinReader(buffer, recy.offset, recy.size);
    while (r.pos < recy.size) {
      const m = r.u8();
      if (m === 255) break;
      sty.recyclableModels.push(m);
    }
  }

  // DELX (delta index) + DELS (delta store): per-sprite damage overlays.
  const delx = chunks.get('DELX');
  const dels = chunks.get('DELS');
  if (delx && dels) {
    const r = new BinReader(buffer, delx.offset, delx.size);
    let storeOfs = 0;
    while (r.pos + 4 <= delx.size) {
      const whichSprite = r.u16();
      const count = r.u8();
      r.skip(1); // pad
      const list: SpriteDelta[] = [];
      for (let i = 0; i < count; i++) {
        const size = r.u16();
        list.push({ data: new Uint8Array(buffer, dels.offset + storeOfs, size) });
        storeOfs += size;
      }
      sty.deltas.set(whichSprite, list);
    }
  }

  return sty;
}

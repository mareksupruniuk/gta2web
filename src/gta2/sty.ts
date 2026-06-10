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
  sprite: number; // relative to first car sprite
  w: number; // collision size in pixels (64 px = 1 block)
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

export class Sty {
  version!: number;
  tileData!: Uint8Array; // raw TILE chunk (pages)
  spriteData!: Uint8Array; // raw SPRG chunk (pages)
  palx!: Uint16Array; // 16384 virtual → physical
  ppal!: Uint8Array; // raw physical palette pages (BGRA)
  palBase!: PaletteBase;
  sprites!: SpriteEntry[];
  spriteBase!: { car: number; ped: number; codeObj: number; mapObj: number; user: number; font: number };
  cars!: CarInfo[];

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
   */
  spriteRGBA(s: number, remapPhys?: number): { w: number; h: number; data: Uint8Array } {
    const e = this.sprites[s];
    const phys = remapPhys ?? this.physPalette(this.palBase.tile + s);
    const out = new Uint8Array(e.w * e.h * 4);
    const pageIdx = Math.floor(e.ptr / (PAGE * PAGE));
    const ofs = e.ptr % (PAGE * PAGE);
    const sx = ofs % PAGE;
    const sy = Math.floor(ofs / PAGE);
    for (let y = 0; y < e.h; y++) {
      for (let x = 0; x < e.w; x++) {
        const c = this.spriteData[pageIdx * PAGE * PAGE + (sy + y) * PAGE + sx + x];
        this.color(phys, c, out, (y * e.w + x) * 4);
      }
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
      sty.cars.push({ model, sprite, w, h, passengers, wreck, rating, remaps });
    }
    if (r.pos !== cari.size) {
      throw new Error(`CARI parse mismatch: ended at ${r.pos} of ${cari.size}`);
    }
  }

  return sty;
}

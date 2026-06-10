import { BinReader, readChunkedFile } from './reader';

/**
 * GTA2 map (.gmp, "GBMP" version 500). The city is a 256x256 grid of columns
 * of blocks (max height 8). The DMAP chunk stores it compressed: a 256x256
 * table of offsets into shared column data, plus a block_info array.
 */

export const MAP_SIZE = 256;

export enum GroundType {
  Air = 0,
  Road = 1,
  Pavement = 2,
  Field = 3,
}

/** Face tile reference, decoded from the packed u16. */
export interface Face {
  tile: number; // 0-1023, 0 = empty/invisible
  flat: boolean;
  flip: boolean;
  rotation: 0 | 1 | 2 | 3; // x90 degrees clockwise
  /** side faces: blocks movement; lids: lighting level instead */
  wall: boolean;
  bulletWall: boolean;
}

export interface BlockInfo {
  left: number;
  right: number;
  top: number;
  bottom: number;
  lid: number;
  arrows: number;
  slopeByte: number;
}

export function decodeSide(v: number): Face {
  return {
    tile: v & 0x3ff,
    wall: (v & 0x400) !== 0,
    bulletWall: (v & 0x800) !== 0,
    flat: (v & 0x1000) !== 0,
    flip: (v & 0x2000) !== 0,
    rotation: ((v >> 14) & 3) as Face['rotation'],
  };
}

export function decodeLid(v: number): Face {
  return {
    tile: v & 0x3ff,
    wall: false,
    bulletWall: false,
    flat: (v & 0x1000) !== 0,
    flip: (v & 0x2000) !== 0,
    rotation: ((v >> 14) & 3) as Face['rotation'],
  };
}

export function lidLightingLevel(v: number): number {
  return (v >> 10) & 3;
}

export function slopeType(b: BlockInfo): number {
  return b.slopeByte >> 2;
}

export function groundType(b: BlockInfo): GroundType {
  return (b.slopeByte & 3) as GroundType;
}

export enum ZoneType {
  GeneralPurpose = 0,
  Navigation = 1,
  TrafficLight = 2,
  ArrowBlocker = 5,
  RailwayPlatform = 6,
  BusStop = 7,
  GeneralTrigger = 8,
  Information = 10,
  RailwayEntry = 11,
  RailwayExit = 12,
  RailwayStop = 13,
  Gang = 14,
  LocalNavigation = 15,
  Restart = 16,
  ArrestRestart = 20,
}

export interface MapZone {
  type: ZoneType;
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
}

export interface TileAnimation {
  base: number; // the tile number that animates
  frameRate: number;
  repeat: number;
  tiles: number[];
}

export interface GmpMap {
  /** base[y*256+x] = offset (in u32 words) into columnWords for that column */
  base: Uint32Array;
  columnWords: Uint32Array;
  blocks: BlockInfo[];
  zones: MapZone[];
  animations: TileAnimation[];
  /** column lookup: top-of-ground height per (x,y), filled lazily */
  getColumn(x: number, y: number): Column;
  getBlock(x: number, y: number, z: number): BlockInfo | null;
  /** z of the highest non-air block lid at (x,y), i.e. ground level for walking */
  groundZ(x: number, y: number): number;
}

export interface Column {
  height: number; // total height (z of top)
  offset: number; // first non-empty z
  /** blockd[i] = block index for z = offset + i */
  blockIds: Uint32Array;
}

class GmpImpl implements GmpMap {
  base!: Uint32Array;
  columnWords!: Uint32Array;
  blocks!: BlockInfo[];
  zones: MapZone[] = [];
  animations: TileAnimation[] = [];
  private colCache = new Map<number, Column>();

  getColumn(x: number, y: number): Column {
    const key = y * MAP_SIZE + x;
    const hit = this.colCache.get(key);
    if (hit) return hit;
    const off = this.base[key];
    const w0 = this.columnWords[off];
    const height = w0 & 0xff;
    const offset = (w0 >> 8) & 0xff;
    const n = height - offset;
    const blockIds = new Uint32Array(n);
    for (let i = 0; i < n; i++) blockIds[i] = this.columnWords[off + 1 + i];
    const col = { height, offset, blockIds };
    this.colCache.set(key, col);
    return col;
  }

  getBlock(x: number, y: number, z: number): BlockInfo | null {
    if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE || z < 0) return null;
    const col = this.getColumn(x, y);
    if (z < col.offset || z >= col.height) return null;
    return this.blocks[col.blockIds[z - col.offset]] ?? null;
  }

  groundZ(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) return 0;
    const col = this.getColumn(x, y);
    for (let i = col.blockIds.length - 1; i >= 0; i--) {
      const b = this.blocks[col.blockIds[i]];
      if (b && (b.lid & 0x3ff) !== 0) return col.offset + i + 1;
    }
    return 0;
  }
}

export function parseGmp(buffer: ArrayBuffer): GmpMap {
  const { version, chunks } = readChunkedFile(buffer, 'GBMP');
  if (version !== 500) throw new Error(`unsupported GMP version ${version}`);
  const dmap = chunks.get('DMAP');
  if (!dmap) throw new Error('GMP has no DMAP chunk');

  const r = new BinReader(buffer, dmap.offset, dmap.size);
  const map = new GmpImpl();

  map.base = new Uint32Array(MAP_SIZE * MAP_SIZE);
  for (let i = 0; i < map.base.length; i++) map.base[i] = r.u32();

  const columnCount = r.u32();
  map.columnWords = new Uint32Array(columnCount);
  for (let i = 0; i < columnCount; i++) map.columnWords[i] = r.u32();

  const blockCount = r.u32();
  const blocks: BlockInfo[] = new Array(blockCount);
  for (let i = 0; i < blockCount; i++) {
    blocks[i] = {
      left: r.u16(),
      right: r.u16(),
      top: r.u16(),
      bottom: r.u16(),
      lid: r.u16(),
      arrows: r.u8(),
      slopeByte: r.u8(),
    };
  }
  map.blocks = blocks;

  const anim = chunks.get('ANIM');
  if (anim) {
    const ar = new BinReader(buffer, anim.offset, anim.size);
    while (ar.pos + 6 <= anim.size) {
      const base = ar.u16();
      const frameRate = ar.u8();
      const repeat = ar.u8();
      const len = ar.u8();
      ar.skip(1); // unused
      const tiles: number[] = [];
      for (let i = 0; i < len; i++) tiles.push(ar.u16());
      map.animations.push({ base, frameRate, repeat, tiles });
    }
  }

  const zone = chunks.get('ZONE');
  if (zone) {
    const zr = new BinReader(buffer, zone.offset, zone.size);
    while (zr.pos + 6 <= zone.size) {
      const type = zr.u8() as ZoneType;
      const x = zr.u8();
      const y = zr.u8();
      const zw = zr.u8();
      const zh = zr.u8();
      const nameLen = zr.u8();
      const name = zr.ascii(nameLen);
      map.zones.push({ type, x, y, w: zw, h: zh, name });
    }
  }
  return map;
}

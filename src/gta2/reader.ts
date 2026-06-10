/** Little-endian binary reader over an ArrayBuffer. */
export class BinReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  pos = 0;

  constructor(buffer: ArrayBuffer, offset = 0, length?: number) {
    this.view = new DataView(buffer, offset, length);
    this.bytes = new Uint8Array(buffer, offset, length);
  }

  get length(): number {
    return this.view.byteLength;
  }

  u8(): number {
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  ascii(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }

  skip(n: number): void {
    this.pos += n;
  }

  slice(n: number): Uint8Array {
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

export interface Chunk {
  name: string;
  offset: number; // absolute offset of chunk data within the file buffer
  size: number;
}

/**
 * GTA2 files (GMP/STY) share a layout: 4-byte magic, u16 version, then a
 * sequence of [4-byte chunk name][u32 size][data] chunks.
 */
export function readChunkedFile(buffer: ArrayBuffer, expectedMagic: string): { version: number; chunks: Map<string, Chunk> } {
  const r = new BinReader(buffer);
  const magic = r.ascii(4);
  if (magic !== expectedMagic) {
    throw new Error(`bad magic: expected ${expectedMagic}, got ${JSON.stringify(magic)}`);
  }
  const version = r.u16();
  const chunks = new Map<string, Chunk>();
  while (r.pos + 8 <= r.length) {
    const name = r.ascii(4);
    const size = r.u32();
    chunks.set(name, { name, offset: r.pos, size });
    r.skip(size);
  }
  return { version, chunks };
}

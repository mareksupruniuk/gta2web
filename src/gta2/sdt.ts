/**
 * GTA2 SDT/RAW sound bank parser.
 *
 * Each style (bil/ste/wil) ships a paired sound bank: a descriptor table
 * (`*.sdt`) plus raw PCM data (`*.raw`). `fstyle.*` is the level-independent
 * (frontend) bank. The record layout was verified empirically against the
 * official freeware data and matches `sdt_entry_0x18` in the gta2_re
 * decompilation (CriminalRETeam/gta2_re, Source/cSampleManager.hpp):
 *
 *   6 little-endian s32 fields per entry, 24 bytes total:
 *     +0  offset          byte offset of the sample inside the .raw
 *     +4  size            sample length in bytes
 *     +8  sampleRate      playback rate in Hz (11025 / 22050 / per-sample)
 *     +12 pitchVariation  max random playback-rate displacement in Hz
 *                         (the game adds rand(-v..v) on each play; 0 = none)
 *     +16 loopStart       loop start, byte offset relative to the sample
 *     +20 loopEnd         loop end byte offset, or -1 to loop to the end
 *                         (only meaningful for sounds the game loops)
 *
 * Samples are mono, 16-bit signed little-endian PCM. Style banks contain
 * 320 entries; fstyle contains 18.
 *
 * Environment-agnostic: operates on ArrayBuffers only (no DOM, no Node APIs).
 */

export const SDT_RECORD_SIZE = 24;

export interface SdtEntry {
  /** Byte offset of the sample data inside the .raw file. */
  offset: number;
  /** Length of the sample data in bytes (2 bytes per PCM frame). */
  size: number;
  /** Playback rate in Hz. */
  sampleRate: number;
  /** Max random playback-rate displacement in Hz (0 = play at exact rate). */
  pitchVariation: number;
  /** Loop start (bytes, relative to sample start); only used for looped sounds. */
  loopStart?: number;
  /** Loop end (bytes, relative to sample start); -1/undefined = to the end. */
  loopEnd?: number;
}

export class SoundBank {
  constructor(
    readonly entries: readonly SdtEntry[],
    private readonly raw: ArrayBuffer,
  ) {}

  /**
   * Decode entry `index` to mono 16-bit PCM. Always returns a copy (some
   * entries sit at odd byte offsets in the .raw, so the data cannot be
   * aliased as an Int16Array view directly).
   */
  pcm(index: number): Int16Array {
    const e = this.entries[index];
    if (!e) throw new RangeError(`sound index ${index} out of range (0..${this.entries.length - 1})`);
    const frames = e.size >> 1;
    const src = new DataView(this.raw, e.offset, frames * 2);
    const out = new Int16Array(frames);
    for (let i = 0; i < frames; i++) out[i] = src.getInt16(i * 2, true);
    return out;
  }
}

export function parseSdt(sdtBuf: ArrayBuffer, rawBuf: ArrayBuffer): SoundBank {
  if (sdtBuf.byteLength % SDT_RECORD_SIZE !== 0) {
    throw new Error(`SDT size ${sdtBuf.byteLength} is not a multiple of ${SDT_RECORD_SIZE}`);
  }
  const count = sdtBuf.byteLength / SDT_RECORD_SIZE;
  const v = new DataView(sdtBuf);
  const entries: SdtEntry[] = [];
  for (let i = 0; i < count; i++) {
    const base = i * SDT_RECORD_SIZE;
    const offset = v.getInt32(base, true);
    const size = v.getInt32(base + 4, true);
    const sampleRate = v.getInt32(base + 8, true);
    const pitchVariation = v.getInt32(base + 12, true);
    const loopStart = v.getInt32(base + 16, true);
    const loopEnd = v.getInt32(base + 20, true);
    if (offset < 0 || size < 0 || offset + size > rawBuf.byteLength) {
      throw new Error(`SDT entry ${i} out of bounds: offset=${offset} size=${size} raw=${rawBuf.byteLength}`);
    }
    entries.push({
      offset,
      size,
      sampleRate,
      pitchVariation,
      loopStart: loopStart !== 0 ? loopStart : undefined,
      loopEnd: loopEnd !== -1 ? loopEnd : undefined,
    });
  }
  return new SoundBank(entries, rawBuf);
}

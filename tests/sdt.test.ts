import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { parseSdt, SDT_RECORD_SIZE } from '../src/gta2/sdt';

const DATA = join(__dirname, '..', 'gamedata', 'audio');
const haveData = existsSync(join(DATA, 'bil.sdt')) && existsSync(join(DATA, 'bil.raw'));

function load(name: string): ArrayBuffer {
  const b = readFileSync(join(DATA, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

describe.skipIf(!haveData)('SDT sound banks (real data)', () => {
  it('record size divides the descriptor table', () => {
    for (const name of ['bil', 'ste', 'wil', 'fstyle']) {
      const sdt = load(`${name}.sdt`);
      expect(sdt.byteLength % SDT_RECORD_SIZE).toBe(0);
    }
  });

  it('style bank parses with a sane entry count', () => {
    const bank = parseSdt(load('bil.sdt'), load('bil.raw'));
    expect(bank.entries.length).toBe(320);
    expect(bank.entries.length).toBeGreaterThan(50);
  });

  it('all entries are in bounds, ascending, with sane sample rates', () => {
    for (const name of ['bil', 'ste', 'wil', 'fstyle']) {
      const raw = load(`${name}.raw`);
      const bank = parseSdt(load(`${name}.sdt`), raw);
      let prev = -1;
      for (const e of bank.entries) {
        expect(e.offset).toBeGreaterThanOrEqual(0);
        expect(e.offset + e.size).toBeLessThanOrEqual(raw.byteLength);
        expect(e.offset).toBeGreaterThanOrEqual(prev);
        prev = e.offset;
        // real banks go as low as 6000 Hz for some rumbles
        expect(e.sampleRate).toBeGreaterThanOrEqual(4000);
        expect(e.sampleRate).toBeLessThanOrEqual(44100);
      }
    }
  });

  it('loop metadata only appears on plausible looping entries', () => {
    const bank = parseSdt(load('bil.sdt'), load('bil.raw'));
    const looped = bank.entries.filter((e) => e.loopStart !== undefined);
    expect(looped.length).toBeGreaterThan(0);
    for (const e of looped) {
      expect(e.loopStart!).toBeGreaterThan(0);
      expect(e.loopStart!).toBeLessThan(e.size);
    }
  });

  it('pcm() returns non-silent 16-bit audio for several entries', () => {
    const bank = parseSdt(load('bil.sdt'), load('bil.raw'));
    // sample a spread of substantial entries (some bank slots are tiny blips)
    const big = bank.entries
      .map((e, i) => ({ i, size: e.size }))
      .filter((e) => e.size > 4000)
      .map((e) => e.i);
    expect(big.length).toBeGreaterThan(50);
    for (const idx of [big[0], big[10], big[Math.floor(big.length / 2)], big[big.length - 1]]) {
      const pcm = bank.pcm(idx);
      expect(pcm.length).toBeGreaterThan(100);
      let sumAbs = 0;
      let peak = 0;
      for (let i = 0; i < pcm.length; i++) {
        const a = Math.abs(pcm[i]);
        sumAbs += a;
        if (a > peak) peak = a;
      }
      expect(sumAbs / pcm.length).toBeGreaterThan(50); // not silence
      expect(peak).toBeGreaterThan(1000); // real signal, not dither
      expect(peak).toBeLessThanOrEqual(32768);
    }
  });

  it('pcm() handles odd-offset entries (copies, does not alias)', () => {
    const bank = parseSdt(load('bil.sdt'), load('bil.raw'));
    const odd = bank.entries.findIndex((e) => e.offset % 2 === 1);
    expect(odd).toBeGreaterThanOrEqual(0);
    const pcm = bank.pcm(odd);
    expect(pcm.length).toBe(bank.entries[odd].size >> 1);
  });

  it('fstyle (frontend) bank parses with 18 entries', () => {
    const bank = parseSdt(load('fstyle.sdt'), load('fstyle.raw'));
    expect(bank.entries.length).toBe(18);
    const pcm = bank.pcm(0);
    expect(pcm.length).toBeGreaterThan(1000);
  });

  it('rejects out-of-bounds data', () => {
    const sdt = new ArrayBuffer(SDT_RECORD_SIZE);
    const v = new DataView(sdt);
    v.setInt32(0, 0, true);
    v.setInt32(4, 100, true); // size 100 > raw size 10
    expect(() => parseSdt(sdt, new ArrayBuffer(10))).toThrow(/out of bounds/);
  });
});

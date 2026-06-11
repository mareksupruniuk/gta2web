import { parseSdt, SoundBank } from '../gta2/sdt';

/**
 * Web-audio adapter for the original GTA2 sound banks (gamedata/audio/*.sdt
 * + *.raw, extracted from the official freeware release). Converts bank
 * entries to AudioBuffers on demand and applies the bank's own per-sample
 * pitch variation, exactly like the original engine did.
 */
export class Gta2Bank {
  private buffers = new Map<number, AudioBuffer>();

  private constructor(
    readonly bank: SoundBank,
    private readonly ctx: AudioContext,
  ) {}

  /** Fetch and parse a district's bank ('wil' | 'ste' | 'bil' | 'fstyle'). */
  static async load(ctx: AudioContext, district: string): Promise<Gta2Bank | null> {
    try {
      const [sdt, raw] = await Promise.all([
        fetch(`gamedata/audio/${district}.sdt`).then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.arrayBuffer();
        }),
        fetch(`gamedata/audio/${district}.raw`).then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.arrayBuffer();
        }),
      ]);
      return new Gta2Bank(parseSdt(sdt, raw), ctx);
    } catch {
      return null; // bank optional: callers fall back to synth/CC0 samples
    }
  }

  get size(): number {
    return this.bank.entries.length;
  }

  /** AudioBuffer for bank entry `index`, cached. */
  buffer(index: number): AudioBuffer | null {
    const cached = this.buffers.get(index);
    if (cached) return cached;
    const entry = this.bank.entries[index];
    if (!entry || entry.size < 4) return null;
    const pcm = this.bank.pcm(index);
    const buf = this.ctx.createBuffer(1, pcm.length, entry.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    this.buffers.set(index, buf);
    return buf;
  }

  /**
   * Playback rate multiplier honouring the entry's pitchVariation field:
   * the original engine displaces the rate by rand(-v..v) Hz on every play.
   */
  playbackRate(index: number): number {
    const entry = this.bank.entries[index];
    if (!entry || entry.pitchVariation <= 0) return 1;
    const dv = (Math.random() * 2 - 1) * entry.pitchVariation;
    return Math.max(0.25, (entry.sampleRate + dv) / entry.sampleRate);
  }

  /** Loop points in seconds for looping entries (engine, siren), if any. */
  loopSeconds(index: number): { start: number; end: number } | null {
    const entry = this.bank.entries[index];
    if (!entry || entry.loopStart === undefined) return null;
    const bytesPerSec = entry.sampleRate * 2;
    return {
      start: entry.loopStart / bytesPerSec,
      end: (entry.loopEnd ?? entry.size) / bytesPerSec,
    };
  }
}

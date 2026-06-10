import type { GameEvent, Vec2, WeaponId } from '../sim/types';

/** Distance (world units) beyond which one-shot events are inaudible. */
const AUDIBLE_RADIUS = 600;
/** Maximum simultaneous one-shot voices. */
const MAX_VOICES = 8;
/** Identical events within this window (seconds) are dropped. */
const RATE_LIMIT_S = 0.03;
/** Overall output level. */
const MASTER_LEVEL = 0.5;
/** Crash speed at which crash volume reaches maximum. */
const CRASH_REF_SPEED = 200;

/**
 * Synthesized audio for the game. All sounds are generated with the Web Audio
 * API (no asset files). Every public method is a safe no-op until init() has
 * been called from a user gesture.
 */
export class AudioManager {
  enabled = true;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  // Engine loop nodes (created lazily on first setEngine(true)).
  private engineOsc: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;

  /** End times (ctx time) of currently-playing one-shot voices. */
  private voiceEnds: number[] = [];
  /** Last trigger time (ctx time) per event key, for rate limiting. */
  private lastPlayed = new Map<string, number>();

  /** Create/resume the AudioContext. Call from a user gesture. Idempotent. */
  init(): void {
    if (typeof AudioContext === 'undefined') return;
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? MASTER_LEVEL : 0;
      this.master.connect(this.ctx.destination);
      this.noiseBuffer = this.makeNoiseBuffer(this.ctx, 2);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => undefined);
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.ctx && this.master) {
      // Smooth ramp; never an abrupt value change.
      this.master.gain.setTargetAtTime(on ? MASTER_LEVEL : 0, this.ctx.currentTime, 0.02);
    }
  }

  /** Short UI click blip (not positional, no rate limit). */
  uiClick(): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1400, t);
    osc.frequency.exponentialRampToValueAtTime(900, t + 0.04);
    const g = this.envelope(t, 0.12, 0.002, 0.05);
    osc.connect(g);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  /** Play positional sounds for sim events, attenuated by listener distance. */
  handleEvents(events: GameEvent[], listenerPos: Vec2): void {
    if (!this.ready() || !this.enabled) return;
    const now = this.ctx!.currentTime;
    for (const ev of events) {
      const gain = this.distanceGain(ev.pos, listenerPos);
      if (gain <= 0.001) continue;

      const key = ev.type === 'shot' ? `shot:${ev.weapon}` : ev.type;
      const last = this.lastPlayed.get(key);
      if (last !== undefined && now - last < RATE_LIMIT_S) continue;
      this.lastPlayed.set(key, now);

      switch (ev.type) {
        case 'shot':
          this.playShot(ev.weapon, gain);
          break;
        case 'hit':
          this.playHit(gain);
          break;
        case 'ped_killed':
        case 'ped_scream':
          this.playScream(gain, ev.type === 'ped_killed');
          break;
        case 'car_enter':
          this.playDoor(gain, true);
          break;
        case 'car_exit':
          this.playDoor(gain, false);
          break;
        case 'car_crash':
          this.playCrash(gain * Math.min(1, Math.max(0.2, ev.speed / CRASH_REF_SPEED)));
          break;
        case 'explosion':
          this.playExplosion(gain);
          break;
        case 'pickup':
          this.playPickup(gain);
          break;
        case 'player_died':
          this.playPlayerDied(gain);
          break;
      }
    }
  }

  /** Continuous engine loop; call every frame while in-game. */
  setEngine(active: boolean, speedRatio: number): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    if (!this.engineOsc && active) this.createEngine(ctx);
    if (!this.engineOsc || !this.engineFilter || !this.engineGain) return;

    const r = Math.min(1, Math.max(0, speedRatio));
    const t = ctx.currentTime;
    if (active) {
      this.engineOsc.frequency.setTargetAtTime(70 + 150 * r, t, 0.08);
      this.engineFilter.frequency.setTargetAtTime(280 + 900 * r, t, 0.08);
      this.engineGain.gain.setTargetAtTime(0.1 + 0.1 * r, t, 0.05);
    } else {
      this.engineGain.gain.setTargetAtTime(0, t, 0.08);
    }
  }

  /** Per-frame housekeeping. */
  update(_dt: number): void {
    if (!this.ctx) return;
    // Prune finished voices so the polyphony cap stays accurate.
    const now = this.ctx.currentTime;
    if (this.voiceEnds.length > 0) {
      this.voiceEnds = this.voiceEnds.filter((end) => end > now);
    }
  }

  // ----- internals ---------------------------------------------------------

  private ready(): boolean {
    return this.ctx !== null && this.master !== null && this.noiseBuffer !== null;
  }

  private distanceGain(pos: Vec2, listener: Vec2): number {
    const d = Math.hypot(pos.x - listener.x, pos.y - listener.y);
    if (d >= AUDIBLE_RADIUS) return 0;
    const x = 1 - d / AUDIBLE_RADIUS;
    return x * x * (3 - 2 * x); // smoothstep falloff
  }

  /** Reserve a one-shot voice slot; returns false when at the polyphony cap. */
  private claimVoice(dur: number): boolean {
    const now = this.ctx!.currentTime;
    this.voiceEnds = this.voiceEnds.filter((end) => end > now);
    if (this.voiceEnds.length >= MAX_VOICES) return false;
    this.voiceEnds.push(now + dur);
    return true;
  }

  private makeNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Gain node with attack/decay envelope, connected to master. */
  private envelope(t: number, peak: number, attack: number, dur: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(Math.max(0.0001, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(this.master!);
    return g;
  }

  /** Filtered burst from the shared noise buffer. */
  private noiseBurst(opts: {
    t: number;
    dur: number;
    peak: number;
    attack?: number;
    type: BiquadFilterType;
    freq: number;
    freqEnd?: number;
    q?: number;
  }): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer!;
    // Randomize read position so rapid bursts don't sound identical.
    const offset = Math.random() * (this.noiseBuffer!.duration - opts.dur - 0.05);
    const filter = ctx.createBiquadFilter();
    filter.type = opts.type;
    filter.Q.value = opts.q ?? 1;
    filter.frequency.setValueAtTime(opts.freq, opts.t);
    if (opts.freqEnd !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), opts.t + opts.dur);
    }
    const g = this.envelope(opts.t, opts.peak, opts.attack ?? 0.002, opts.dur);
    src.connect(filter);
    filter.connect(g);
    src.start(opts.t, Math.max(0, offset), opts.dur + 0.05);
    src.stop(opts.t + opts.dur + 0.05);
  }

  /** Simple oscillator tone with pitch ramp and envelope. */
  private tone(opts: {
    t: number;
    dur: number;
    peak: number;
    attack?: number;
    type: OscillatorType;
    freq: number;
    freqEnd?: number;
  }): OscillatorNode {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = opts.type;
    osc.frequency.setValueAtTime(opts.freq, opts.t);
    if (opts.freqEnd !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.freqEnd), opts.t + opts.dur);
    }
    osc.connect(this.envelope(opts.t, opts.peak, opts.attack ?? 0.003, opts.dur));
    osc.start(opts.t);
    osc.stop(opts.t + opts.dur + 0.02);
    return osc;
  }

  // ----- one-shot sounds ---------------------------------------------------

  private playShot(weapon: WeaponId, gain: number): void {
    const t = this.ctx!.currentTime;
    switch (weapon) {
      case 'pistol':
        if (!this.claimVoice(0.14)) return;
        // Sharp single crack.
        this.noiseBurst({ t, dur: 0.13, peak: 0.55 * gain, type: 'lowpass', freq: 3200, freqEnd: 500, q: 0.8 });
        break;
      case 'uzi':
        if (!this.claimVoice(0.07)) return;
        // Short, snappy.
        this.noiseBurst({ t, dur: 0.06, peak: 0.4 * gain, type: 'lowpass', freq: 2600, freqEnd: 700, q: 0.7 });
        break;
      case 'shotgun':
        if (!this.claimVoice(0.35)) return;
        // Boomy and wide: low boom plus mid blast.
        this.noiseBurst({ t, dur: 0.32, peak: 0.7 * gain, type: 'lowpass', freq: 1000, freqEnd: 150, q: 0.9 });
        this.noiseBurst({ t, dur: 0.12, peak: 0.35 * gain, type: 'bandpass', freq: 1800, q: 0.5 });
        break;
      case 'fists':
        if (!this.claimVoice(0.14)) return;
        // Soft whoosh + low thud.
        this.noiseBurst({ t, dur: 0.12, peak: 0.18 * gain, attack: 0.03, type: 'bandpass', freq: 500, freqEnd: 250, q: 1.5 });
        this.tone({ t, dur: 0.08, peak: 0.2 * gain, type: 'sine', freq: 110, freqEnd: 60 });
        break;
    }
  }

  private playHit(gain: number): void {
    const t = this.ctx!.currentTime;
    if (!this.claimVoice(0.05)) return;
    this.noiseBurst({ t, dur: 0.03, peak: 0.3 * gain, attack: 0.001, type: 'bandpass', freq: 1200, q: 2 });
    this.tone({ t, dur: 0.05, peak: 0.2 * gain, attack: 0.001, type: 'sine', freq: 200, freqEnd: 90 });
  }

  private playScream(gain: number, dying: boolean): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const dur = dying ? 0.45 : 0.3;
    if (!this.claimVoice(dur)) return;
    // Cartoonish pitch-sweep: up then sliding down.
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const base = 700 + Math.random() * 300;
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.exponentialRampToValueAtTime(base * 1.5, t + dur * 0.25);
    osc.frequency.exponentialRampToValueAtTime(dying ? 180 : 450, t + dur);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1100;
    filter.Q.value = 1.2;
    const g = this.envelope(t, 0.22 * gain, 0.02, dur);
    osc.connect(filter);
    filter.connect(g);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private playDoor(gain: number, entering: boolean): void {
    const t = this.ctx!.currentTime;
    if (!this.claimVoice(0.12)) return;
    // Metallic clunk: low thump + brief mid rattle.
    const freq = entering ? 140 : 170;
    this.tone({ t, dur: 0.09, peak: 0.3 * gain, attack: 0.002, type: 'sine', freq, freqEnd: freq * 0.5 });
    this.noiseBurst({ t: t + 0.01, dur: 0.05, peak: 0.12 * gain, type: 'bandpass', freq: 900, q: 4 });
  }

  private playCrash(gain: number): void {
    const t = this.ctx!.currentTime;
    if (!this.claimVoice(0.3)) return;
    // Metallic crunch: two resonant noise bands + low impact.
    this.noiseBurst({ t, dur: 0.25, peak: 0.45 * gain, type: 'bandpass', freq: 2200, freqEnd: 800, q: 1.8 });
    this.noiseBurst({ t, dur: 0.2, peak: 0.4 * gain, type: 'bandpass', freq: 600, freqEnd: 250, q: 1.2 });
    this.tone({ t, dur: 0.12, peak: 0.3 * gain, attack: 0.002, type: 'sine', freq: 90, freqEnd: 45 });
  }

  private playExplosion(gain: number): void {
    const t = this.ctx!.currentTime;
    if (!this.claimVoice(1.2)) return;
    // Big low boom with long decay + sub sine drop.
    this.noiseBurst({ t, dur: 1.1, peak: 0.9 * gain, attack: 0.005, type: 'lowpass', freq: 900, freqEnd: 80, q: 1 });
    this.tone({ t, dur: 0.8, peak: 0.6 * gain, attack: 0.005, type: 'sine', freq: 130, freqEnd: 30 });
  }

  private playPickup(gain: number): void {
    const t = this.ctx!.currentTime;
    if (!this.claimVoice(0.25)) return;
    // Pleasant two-note blip (major third up).
    this.tone({ t, dur: 0.09, peak: 0.18 * gain, type: 'triangle', freq: 880 });
    this.tone({ t: t + 0.09, dur: 0.13, peak: 0.18 * gain, type: 'triangle', freq: 1108.7 });
  }

  private playPlayerDied(gain: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    if (!this.claimVoice(1.3)) return;
    // Long descending tone through a closing lowpass.
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(380, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 1.2);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1500, t);
    filter.frequency.exponentialRampToValueAtTime(200, t + 1.2);
    const g = this.envelope(t, 0.35 * gain, 0.01, 1.2);
    osc.connect(filter);
    filter.connect(g);
    osc.start(t);
    osc.stop(t + 1.25);
  }

  // ----- engine loop -------------------------------------------------------

  private createEngine(ctx: AudioContext): void {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 70;

    // Slight wobble for texture: slow LFO modulating oscillator frequency.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 9;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 5; // +/- 5 Hz wobble
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 280;
    filter.Q.value = 1.2;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.master!);
    osc.start();
    lfo.start();

    this.engineOsc = osc;
    this.engineFilter = filter;
    this.engineGain = gain;
  }
}

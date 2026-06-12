import type { GameEvent, Vec2, WeaponId } from '../sim/types';
import type { Gta2Bank } from './gta2bank';
import { SFX } from './gta2-sfx';

/** Distance (world units) beyond which one-shot events are inaudible. */
const AUDIBLE_RADIUS = 600;
/** Maximum simultaneous one-shot voices. */
const MAX_VOICES = 8;
/** Identical events within this window (seconds) are dropped. */
const RATE_LIMIT_S = 0.03;
/** Skid events are noisier; cap them harder. */
const SKID_RATE_LIMIT_S = 0.15;
/** Overall output level. */
const MASTER_LEVEL = 0.5;
/** Crash speed at which crash volume reaches maximum. */
const CRASH_REF_SPEED = 200;
/** Engine loop playbackRate range driven by speedRatio. */
const ENGINE_RATE_MIN = 0.6;
const ENGINE_RATE_MAX = 1.6;
/** GTA2 bank engine sample playbackRate range (idle → full speed). */
const BANK_ENGINE_RATE_MIN = 0.75;
const BANK_ENGINE_RATE_MAX = 1.5;
/** Crash speed at/above which the heavy bank impact (13) is used. */
const CRASH_HEAVY_SPEED = 120;
/** Crash speed at/above which an extra crunch layer (43-48) is added. */
const CRASH_CRUNCH_SPEED = 70;
/** Minimum spacing between footstep one-shots (seconds). */
const FOOTSTEP_RATE_LIMIT_S = 0.25;

/**
 * Weapon ids this layer understands. The sim's WeaponId union is converging on
 * the same set; the local union keeps this file compiling on both sides of
 * that change (duplicated members collapse harmlessly).
 */
type AudioWeaponId =
  | WeaponId
  | 'fists'
  | 'pistol'
  | 'dual_pistol'
  | 'uzi'
  | 's_uzi'
  | 'silenced_s_uzi'
  | 'shotgun'
  | 'rocket'
  | 'flamethrower'
  | 'electrogun'
  | 'grenade'
  | 'molotov';

/**
 * Events this layer understands: everything in the sim's GameEvent plus the
 * new event shapes that are landing alongside the new weapons. Same
 * forward-compatibility trick as AudioWeaponId.
 */
type AudioEvent =
  | GameEvent
  | { type: 'shot'; weapon: AudioWeaponId; pos: Vec2 }
  | { type: 'molotov_smash'; pos: Vec2 }
  | { type: 'ped_on_fire'; pos: Vec2 }
  | { type: 'skid'; pos: Vec2; intensity: number }
  | { type: 'horn'; pos: Vec2 };

/**
 * CC0 sample files served from public/sounds/ (see src/audio/README.md for
 * the event mapping). Sources: OpenGameArt "Gunshots" by LarkPay,
 * OpenGameArt "Racing car engine sound loops" by domasx2, OpenGameArt
 * "Car Sound Effects Pack" by ggbotnet, and Kenney's Sci-Fi Sounds /
 * Impact Sounds / Interface Sounds packs (all CC0 1.0; provenance in
 * assets-raw/ATTRIBUTION.md).
 */
const SAMPLE_FILES = {
  'shot-pistol': 'shot-pistol.wav',
  'shot-uzi': 'shot-uzi.wav',
  'shot-shotgun': 'shot-shotgun.wav',
  'rocket-launch': 'rocket-launch.ogg',
  'explosion-crunch': 'explosion-crunch.ogg',
  'explosion-low': 'explosion-low.ogg',
  'crash-metal': 'crash-metal.ogg',
  'crash-metal2': 'crash-metal2.ogg',
  'crash-metal3': 'crash-metal3.ogg',
  'glass-shatter': 'glass-shatter.ogg',
  horn: 'horn.ogg',
  'door-open': 'door-open.ogg',
  'door-close': 'door-close.ogg',
  pickup: 'pickup.ogg',
  'ui-click': 'ui-click.ogg',
  'engine-loop': 'engine-loop.wav',
} as const;

type SampleName = keyof typeof SAMPLE_FILES;

const CRASH_SAMPLES: SampleName[] = ['crash-metal', 'crash-metal2', 'crash-metal3'];

/** A lazily-built continuous loop: sources feed `gain`, which ramps 0..level. */
interface LoopVoice {
  gain: GainNode;
}

/**
 * Game audio: real CC0 samples (fetched and decoded asynchronously after
 * init()) with the original Web Audio synthesis kept as a fallback for any
 * sample that has not loaded (or failed to load). Every public method is a
 * safe no-op until init() has been called from a user gesture.
 */
export class AudioManager {
  enabled = true;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private brownNoiseBuffer: AudioBuffer | null = null;
  /** Sparse-impulse buffers for crackle textures (fire / electricity). */
  private crackleSlow: AudioBuffer | null = null;
  private crackleFast: AudioBuffer | null = null;

  /** Decoded CC0 samples, populated asynchronously after init(). */
  private samples = new Map<SampleName, AudioBuffer>();
  private samplesRequested = false;

  /**
   * Original GTA2 sound bank (attachBank). When present, one-shots and loops
   * prefer bank samples; CC0/synth paths remain the fallback for any missing
   * entry (or when no bank is attached at all).
   */
  private bank: Gta2Bank | null = null;
  /** Bank engine sample id (3-8) selected via setEngineClass; null = CC0/synth. */
  private engineBankClass: number | null = null;

  // Synth engine loop nodes (fallback; created lazily on first setEngine(true)).
  private engineOsc: OscillatorNode | null = null;
  private engineLfo: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;

  // Sample engine loop nodes (used once the engine-loop sample has decoded).
  private engineSrc: AudioBufferSourceNode | null = null;
  private engineSrcGain: GainNode | null = null;
  /** Which sample the running engineSrc plays: 'cc0' or 'bank:<idx>'. */
  private engineSrcKey: string | null = null;

  // Continuous synth loops (created lazily on first activation).
  private flameLoop: LoopVoice | null = null;
  private electroLoop: LoopVoice | null = null;
  private fireLoop: LoopVoice | null = null;
  private ambienceLoop: LoopVoice | null = null;
  private sirenLoop: LoopVoice | null = null;

  /** Gain level applied to the siren loop fader (bank sample vs synth differ). */
  private sirenLevel = 0.14;

  /** Crowd chatter (setCrowd): current intensity and next scheduled chatter time. */
  private crowdIntensity = 0;
  private nextChatterAt = 0;

  /** Street ambience extras: birds, distant horns, traffic hum. */
  private ambienceActive = false;
  private nextBirdAt = 0;
  private nextDistantHornAt = 0;
  private trafficLoop: LoopVoice | null = null;
  private trafficIntensity = 0;

  /** End times (ctx time) of currently-playing one-shot voices. */
  private voiceEnds: number[] = [];
  /** Last trigger time (ctx time) per event key, for rate limiting. */
  private lastPlayed = new Map<string, number>();

  /** Decoded GTA2 announcer vocals (gamedata/audio/vocals/), fetched lazily. */
  private vocals = new Map<string, AudioBuffer | null>();
  /** ctx time until which the announcer voice is busy (no self-overlap). */
  private vocalBusyUntil = 0;

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
      this.brownNoiseBuffer = this.makeBrownNoiseBuffer(this.ctx, 3);
      this.crackleSlow = this.makeCrackleBuffer(this.ctx, 2, 0.0009);
      this.crackleFast = this.makeCrackleBuffer(this.ctx, 1.5, 0.006);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => undefined);
    }
    this.loadSamples();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.ctx && this.master) {
      // Smooth ramp; never an abrupt value change.
      this.master.gain.setTargetAtTime(on ? MASTER_LEVEL : 0, this.ctx.currentTime, 0.02);
    }
  }

  /**
   * Attach (or detach with null) the original GTA2 sound bank. Once attached,
   * one-shots and loops prefer the bank samples (see src/audio/gta2-sfx.ts
   * for the id table); the CC0/synth paths stay as fallback for any entry the
   * bank does not provide. Typed `unknown` so callers without the gta2bank
   * module in scope can pass the bank through opaquely.
   */
  /** The manager's AudioContext (for building bank AudioBuffers); null before init(). */
  get audioContext(): AudioContext | null {
    return this.ctx;
  }

  attachBank(bank: unknown | null): void {
    this.bank = (bank as Gta2Bank | null) ?? null;
    // Drop any live loops built from the previous source so they get rebuilt
    // from the new one (bank siren vs synth siren, bank engine vs CC0/synth).
    if (this.ctx) {
      const t = this.ctx.currentTime;
      if (this.sirenLoop) {
        this.sirenLoop.gain.gain.setTargetAtTime(0, t, 0.1);
        this.sirenLoop = null;
        this.sirenLevel = 0.14;
      }
      if (this.engineSrc) this.stopEngineSample(t);
    }
  }

  /** Short UI click blip (not positional, no rate limit, no polyphony cap). */
  uiClick(): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const buf = this.samples.get('ui-click');
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = 0.4;
      src.connect(g);
      g.connect(this.master!);
      src.start(t);
      return;
    }
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1400, t);
    osc.frequency.exponentialRampToValueAtTime(900, t + 0.04);
    const g = this.envelope(t, 0.12, 0.002, 0.05);
    osc.connect(g);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  /**
   * GTA2 announcer voice (BUSTED!, WASTED!, weapon pickups, taunts) from the
   * original Vocals/*.wav set. One voice: a playing vocal blocks new ones
   * unless `priority` (so BUSTED always lands). Files fetch+decode lazily.
   */
  playVocal(name: string, opts: { gain?: number; priority?: boolean } = {}): void {
    if (!this.ready() || !this.enabled) return;
    const ctx = this.ctx!;
    if (!opts.priority && ctx.currentTime < this.vocalBusyUntil) return;
    if (!this.vocals.has(name)) {
      this.vocals.set(name, null); // mark as loading
      void fetch(`gamedata/audio/vocals/${name}.wav`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`no vocal ${name}`))))
        .then((ab) => ctx.decodeAudioData(ab))
        .then((buf) => {
          this.vocals.set(name, buf);
          this.playVocal(name, opts);
        })
        .catch(() => this.vocals.delete(name));
      return;
    }
    const buf = this.vocals.get(name);
    if (!buf) return; // still decoding
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = opts.gain ?? 0.85;
    src.connect(g);
    g.connect(this.master!);
    src.start();
    this.vocalBusyUntil = ctx.currentTime + buf.duration;
  }

  /** Classic double-chirp payphone ring (synth). */
  playPhoneRing(): void {
    if (!this.ready() || !this.enabled) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    for (let burst = 0; burst < 2; burst++) {
      const start = t0 + burst * 0.22;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 1180;
      const trill = ctx.createOscillator();
      trill.type = 'square';
      trill.frequency.value = 22; // bell trill
      const trillGain = ctx.createGain();
      trillGain.gain.value = 320;
      trill.connect(trillGain);
      trillGain.connect(osc.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(0.07, start + 0.01);
      g.gain.setValueAtTime(0.07, start + 0.13);
      g.gain.linearRampToValueAtTime(0, start + 0.16);
      osc.connect(g);
      g.connect(this.master!);
      osc.start(start);
      trill.start(start);
      osc.stop(start + 0.18);
      trill.stop(start + 0.18);
    }
  }

  /** Play positional sounds for sim events, attenuated by listener distance. */
  handleEvents(events: GameEvent[], listenerPos: Vec2): void {
    if (!this.ready() || !this.enabled) return;
    const now = this.ctx!.currentTime;
    for (const ev of events as AudioEvent[]) {
      const gain = this.distanceGain(ev.pos, listenerPos);
      if (gain <= 0.001) continue;

      const key = ev.type === 'shot' ? `shot:${ev.weapon}` : ev.type;
      const limit = ev.type === 'skid' ? SKID_RATE_LIMIT_S : RATE_LIMIT_S;
      const last = this.lastPlayed.get(key);
      if (last !== undefined && now - last < limit) continue;
      this.lastPlayed.set(key, now);

      switch (ev.type) {
        case 'shot':
          this.playShot(ev.weapon, gain);
          break;
        case 'hit':
          this.playHit(gain, ev.surface);
          break;
        case 'ped_killed':
        case 'ped_scream':
          this.playScream(gain, ev.type === 'ped_killed');
          break;
        case 'ped_on_fire':
          this.playBurningScream(gain);
          break;
        case 'car_enter':
          this.playDoor(gain, true);
          break;
        case 'car_exit':
          this.playDoor(gain, false);
          break;
        case 'car_crash':
          this.playCrash(gain * Math.min(1, Math.max(0.2, ev.speed / CRASH_REF_SPEED)), ev.speed);
          break;
        case 'explosion':
          this.playExplosion(gain);
          break;
        case 'molotov_smash':
          this.playMolotovSmash(gain);
          break;
        case 'skid':
          this.playSkid(gain, Math.min(1, Math.max(0, ev.intensity)));
          break;
        case 'horn':
          this.playHorn(gain);
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

  /**
   * Select the GTA2 bank engine sample for the player's current vehicle.
   * `cls` is a bank sample id 3-8 (per-vehicle-class engine revs, see
   * SFX.ENGINE_CLASS_* in src/audio/gta2-sfx.ts; callers compute it from the
   * car model). null restores the CC0/synth engine behavior. Takes effect on
   * the next setEngine() call, with a smooth crossfade.
   */
  setEngineClass(cls: number | null): void {
    if (cls === this.engineBankClass) return;
    this.engineBankClass = cls;
  }

  /** Continuous engine loop; call every frame while in-game. */
  setEngine(active: boolean, speedRatio: number): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const r = Math.min(1, Math.max(0, speedRatio));
    const t = ctx.currentTime;

    // Prefer the original bank engine sample when a class id is set
    // (setEngineClass) and the bank provides it.
    const cls = this.engineBankClass;
    const bankBuf = cls !== null && this.bank ? this.bank.buffer(cls) : null;
    if (cls !== null && bankBuf) {
      if (this.engineOsc) this.stopSynthEngine(t); // hand over from synth
      const key = `bank:${cls}`;
      if (this.engineSrc && this.engineSrcKey !== key) this.stopEngineSample(t);
      if (!this.engineSrc && active) {
        this.createEngineSample(ctx, bankBuf, key, this.bank!.loopSeconds(cls), BANK_ENGINE_RATE_MIN);
      }
      if (!this.engineSrc || !this.engineSrcGain) return;
      if (active) {
        const rate = BANK_ENGINE_RATE_MIN + (BANK_ENGINE_RATE_MAX - BANK_ENGINE_RATE_MIN) * r;
        this.engineSrc.playbackRate.setTargetAtTime(rate, t, 0.08);
        this.engineSrcGain.gain.setTargetAtTime(0.16 + 0.14 * r, t, 0.05);
      } else {
        this.engineSrcGain.gain.setTargetAtTime(0, t, 0.08);
      }
      return;
    }

    // Prefer the seamless CC0 sample loop once it has decoded.
    const loop = this.samples.get('engine-loop');
    if (loop) {
      if (this.engineOsc) this.stopSynthEngine(t); // hand over from synth
      if (this.engineSrc && this.engineSrcKey !== 'cc0') this.stopEngineSample(t); // bank → CC0
      if (!this.engineSrc && active) this.createEngineSample(ctx, loop, 'cc0', null, ENGINE_RATE_MIN);
      if (!this.engineSrc || !this.engineSrcGain) return;
      if (active) {
        const rate = ENGINE_RATE_MIN + (ENGINE_RATE_MAX - ENGINE_RATE_MIN) * r;
        this.engineSrc.playbackRate.setTargetAtTime(rate, t, 0.08);
        this.engineSrcGain.gain.setTargetAtTime(0.16 + 0.14 * r, t, 0.05);
      } else {
        this.engineSrcGain.gain.setTargetAtTime(0, t, 0.08);
      }
      return;
    }

    // Synth fallback while the sample is loading (or if it failed).
    if (this.engineSrc) this.stopEngineSample(t); // orphaned sample loop (e.g. bank detached)
    if (!this.engineOsc && active) this.createEngine(ctx);
    if (!this.engineOsc || !this.engineFilter || !this.engineGain) return;
    if (active) {
      this.engineOsc.frequency.setTargetAtTime(70 + 150 * r, t, 0.08);
      this.engineFilter.frequency.setTargetAtTime(280 + 900 * r, t, 0.08);
      this.engineGain.gain.setTargetAtTime(0.1 + 0.1 * r, t, 0.05);
    } else {
      this.engineGain.gain.setTargetAtTime(0, t, 0.08);
    }
  }

  /** Continuous roaring flame jet loop (flamethrower held down). */
  setFlamethrower(active: boolean): void {
    if (!this.ready()) return;
    if (!this.flameLoop && active) this.flameLoop = this.createFlameLoop(this.ctx!);
    if (!this.flameLoop) return;
    this.flameLoop.gain.gain.setTargetAtTime(active ? 0.3 : 0, this.ctx!.currentTime, active ? 0.04 : 0.09);
  }

  /** Continuous electric crackle/buzz loop (electrogun held down). */
  setElectro(active: boolean): void {
    if (!this.ready()) return;
    if (!this.electroLoop && active) this.electroLoop = this.createElectroLoop(this.ctx!);
    if (!this.electroLoop) return;
    this.electroLoop.gain.gain.setTargetAtTime(active ? 0.16 : 0, this.ctx!.currentTime, active ? 0.025 : 0.06);
  }

  /** Burning-fire crackle near the player; gain follows intensity 0..1. */
  setFireNearby(intensity: number): void {
    if (!this.ready()) return;
    const level = Math.min(1, Math.max(0, intensity));
    if (!this.fireLoop && level > 0.001) this.fireLoop = this.createFireLoop(this.ctx!);
    if (!this.fireLoop) return;
    this.fireLoop.gain.gain.setTargetAtTime(0.32 * level, this.ctx!.currentTime, 0.12);
  }

  /** Police siren wail; gain follows proximity 0..1 of the nearest cop car. */
  setSiren(intensity: number): void {
    if (!this.ready()) return;
    const level = Math.min(1, Math.max(0, intensity));
    if (!this.sirenLoop && level > 0.001) {
      // Prefer the original bank siren loop (id 14); synth two-tone fallback.
      const bankLoop = this.createBankSirenLoop(this.ctx!);
      if (bankLoop) {
        this.sirenLoop = bankLoop;
        this.sirenLevel = 0.22;
      } else {
        this.sirenLoop = this.createSirenLoop(this.ctx!);
        this.sirenLevel = 0.14;
      }
    }
    if (!this.sirenLoop) return;
    this.sirenLoop.gain.gain.setTargetAtTime(this.sirenLevel * level, this.ctx!.currentTime, 0.15);
  }

  /** Very quiet city ambience bed (low wind/rumble), barely audible. */
  setAmbience(active: boolean): void {
    if (!this.ready()) return;
    this.ambienceActive = active;
    if (!this.ambienceLoop && active) this.ambienceLoop = this.createAmbienceLoop(this.ctx!);
    if (!this.ambienceLoop) return;
    this.ambienceLoop.gain.gain.setTargetAtTime(active ? 0.045 : 0, this.ctx!.currentTime, 0.4);
  }

  /**
   * Distant traffic hum, 0..1 by how busy the streets around the player are.
   * A lowpassed rumble loop whose level follows the intensity.
   */
  setTraffic(intensity: number): void {
    if (!this.ready()) return;
    this.trafficIntensity = Math.min(1, Math.max(0, intensity));
    if (!this.trafficLoop && this.trafficIntensity > 0) {
      const ctx = this.ctx!;
      const src = ctx.createBufferSource();
      src.buffer = this.brownNoiseBuffer!;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 160;
      filter.Q.value = 0.4;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.master!);
      src.start();
      this.trafficLoop = { gain };
    }
    if (this.trafficLoop) {
      this.trafficLoop.gain.gain.setTargetAtTime(0.10 * this.trafficIntensity, this.ctx!.currentTime, 0.8);
    }
  }

  /** Short synth bird chirp: a few quick descending blips. */
  private playBirdChirp(): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const blips = 2 + Math.floor(Math.random() * 3);
    const base = 2800 + Math.random() * 1400;
    for (let i = 0; i < blips; i++) {
      const t = t0 + i * (0.09 + Math.random() * 0.05);
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(base + Math.random() * 500, t);
      osc.frequency.exponentialRampToValueAtTime(base * 0.72, t + 0.07);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.025 + Math.random() * 0.02, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      osc.connect(g);
      g.connect(this.master!);
      osc.start(t);
      osc.stop(t + 0.1);
    }
  }

  /**
   * Player footstep one-shot from the bank (pavement set 198-201, random of
   * 4). Quiet while walking, louder running, ±5% rate. Rate-limited to one
   * step per 0.25s. No-op when no bank is attached (there is no CC0/synth
   * footstep — the remake previously had none).
   */
  playFootstep(running: boolean): void {
    if (!this.ready() || !this.enabled) return;
    const now = this.ctx!.currentTime;
    const last = this.lastPlayed.get('footstep');
    if (last !== undefined && now - last < FOOTSTEP_RATE_LIMIT_S) return;
    this.lastPlayed.set('footstep', now);
    const idx = SFX.FOOTSTEP_FIRST + Math.floor(Math.random() * SFX.FOOTSTEP_COUNT);
    this.playBankSample(idx, running ? 0.2 : 0.08, { rate: 0.95 + Math.random() * 0.1 });
  }

  /**
   * Ambient crowd murmur, 0..1. While > 0, a random ped chatter sample
   * (bank 233-238) plays every 2-6 seconds (more often at higher intensity)
   * at low volume scaled by intensity. Scheduling runs in update(). No-op
   * without an attached bank (chatter has no CC0/synth equivalent).
   */
  setCrowd(intensity: number): void {
    this.crowdIntensity = Math.min(1, Math.max(0, intensity));
  }

  /** Per-frame housekeeping. */
  update(_dt: number): void {
    if (!this.ctx) return;
    // Prune finished voices so the polyphony cap stays accurate.
    const now = this.ctx.currentTime;
    if (this.voiceEnds.length > 0) {
      this.voiceEnds = this.voiceEnds.filter((end) => end > now);
    }
    // Occasional crowd chatter while setCrowd intensity > 0.
    if (this.crowdIntensity > 0.001 && this.enabled && this.bank && this.ready()) {
      if (now >= this.nextChatterAt) {
        const idx = SFX.PED_CHATTER_FIRST + Math.floor(Math.random() * SFX.PED_CHATTER_COUNT);
        this.playBankSample(idx, (0.05 + Math.random() * 0.07) * this.crowdIntensity);
        // 2-6s spacing, biased shorter as the crowd gets denser.
        this.nextChatterAt = now + 2 + (1 - this.crowdIntensity) * 2 + Math.random() * 2;
      }
    }
    // Street ambience extras while in-game: birds + distant horns.
    if (this.ambienceActive && this.enabled && this.ready()) {
      if (now >= this.nextBirdAt) {
        this.playBirdChirp();
        this.nextBirdAt = now + 3 + Math.random() * 7;
      }
      if (now >= this.nextDistantHornAt) {
        // a far-off honk, quiet and pitch-shifted, denser when streets are busy
        this.playHorn(0.06 + 0.08 * this.trafficIntensity);
        this.nextDistantHornAt = now + 8 + Math.random() * 14;
      }
    }
  }

  // ----- internals ---------------------------------------------------------

  private ready(): boolean {
    return this.ctx !== null && this.master !== null && this.noiseBuffer !== null;
  }

  /** Fire-and-forget fetch+decode of all samples. Failures keep synth fallback. */
  private loadSamples(): void {
    if (this.samplesRequested || !this.ctx) return;
    this.samplesRequested = true;
    const base = import.meta.env.BASE_URL ?? './';
    for (const [name, file] of Object.entries(SAMPLE_FILES) as [SampleName, string][]) {
      void fetch(`${base}sounds/${file}`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.arrayBuffer();
        })
        .then((data) => this.ctx!.decodeAudioData(data))
        .then((buf) => {
          this.samples.set(name, buf);
        })
        .catch(() => undefined);
    }
  }

  /**
   * Play a decoded one-shot sample. Returns false only when the sample is not
   * loaded yet (caller should fall back to synth). When the polyphony cap is
   * reached the sound is dropped but true is still returned.
   */
  private playSample(name: SampleName, gain: number, opts: { rate?: number; maxDur?: number } = {}): boolean {
    const buf = this.samples.get(name);
    if (!buf) return false;
    this.startOneShot(buf, gain, opts.rate ?? 1, opts.maxDur);
    return true;
  }

  /**
   * Play a one-shot from the attached GTA2 bank. Returns false when no bank
   * is attached or the bank has no usable entry at `index` (caller falls back
   * to the CC0/synth path). The bank's own per-sample pitch variation
   * (Gta2Bank.playbackRate) is always applied; `opts.rate` multiplies on top.
   * As with playSample, a polyphony-cap drop still returns true.
   */
  private playBankSample(index: number, gain: number, opts: { rate?: number; maxDur?: number } = {}): boolean {
    if (!this.bank) return false;
    const buf = this.bank.buffer(index);
    if (!buf) return false;
    const rate = (opts.rate ?? 1) * this.bank.playbackRate(index);
    this.startOneShot(buf, gain, rate, opts.maxDur);
    return true;
  }

  /** Start a one-shot AudioBuffer voice (shared by CC0 and bank samples). */
  private startOneShot(buf: AudioBuffer, gain: number, rate: number, maxDur?: number): void {
    const ctx = this.ctx!;
    const natural = buf.duration / rate;
    const dur = maxDur !== undefined ? Math.min(maxDur, natural) : natural;
    if (!this.claimVoice(dur)) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, gain), t);
    src.connect(g);
    g.connect(this.master!);
    src.start(t);
    if (dur < natural) {
      // Trim long tails with a quick fade so capped voices free up promptly.
      const fade = Math.min(0.06, dur * 0.5);
      g.gain.setValueAtTime(Math.max(0.0001, gain), t + dur - fade);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.stop(t + dur);
    }
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

  /** Brown (integrated) noise: deep wind/rumble texture for ambience beds. */
  private makeBrownNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      b = (b + 0.02 * white) / 1.02;
      data[i] = b * 3.5;
    }
    return buf;
  }

  /**
   * Sparse random impulses with short decay tails — the raw material for
   * fire crackle (low density) and electric fizz (high density).
   */
  private makeCrackleBuffer(ctx: AudioContext, seconds: number, density: number): AudioBuffer {
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buf.getChannelData(0);
    let env = 0;
    for (let i = 0; i < data.length; i++) {
      if (Math.random() < density) env = 0.4 + Math.random() * 0.6;
      data[i] = (Math.random() * 2 - 1) * env;
      env *= 0.96;
    }
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

  private playShot(weapon: AudioWeaponId, gain: number): void {
    const t = this.ctx!.currentTime;
    switch (weapon) {
      case 'pistol':
        // Original bank pistol shot; pitch variation comes from the SDT entry.
        if (this.playBankSample(SFX.SHOT_PISTOL, 0.5 * gain)) return;
        // Slight rate jitter so rapid fire does not sound machine-stamped.
        if (this.playSample('shot-pistol', 0.5 * gain, { rate: 0.96 + Math.random() * 0.08, maxDur: 1.0 })) return;
        if (!this.claimVoice(0.14)) return;
        // Sharp single crack.
        this.noiseBurst({ t, dur: 0.13, peak: 0.55 * gain, type: 'lowpass', freq: 3200, freqEnd: 500, q: 0.8 });
        break;
      case 'dual_pistol':
        // Same bank sample as pistol (sound_obj.cpp:1882), a touch louder.
        if (this.playBankSample(SFX.SHOT_PISTOL, 0.56 * gain)) return;
        // Pistol sound, slightly wider pitch spread and a touch louder.
        if (this.playSample('shot-pistol', 0.56 * gain, { rate: 0.92 + Math.random() * 0.16, maxDur: 1.0 })) return;
        if (!this.claimVoice(0.14)) return;
        this.noiseBurst({ t, dur: 0.13, peak: 0.62 * gain, type: 'lowpass', freq: 3400, freqEnd: 500, q: 0.8 });
        break;
      case 'uzi':
        // Original bank machine-gun shot.
        if (this.playBankSample(SFX.SHOT_SMG, 0.42 * gain)) return;
        // Snappier shot pitched well up and trimmed short so the uzi reads
        // clearly different from the pistol.
        if (this.playSample('shot-uzi', 0.32 * gain, { rate: 1.55 + Math.random() * 0.15, maxDur: 0.18 })) return;
        if (!this.claimVoice(0.07)) return;
        // Short, snappy.
        this.noiseBurst({ t, dur: 0.06, peak: 0.4 * gain, type: 'lowpass', freq: 2600, freqEnd: 700, q: 0.7 });
        break;
      case 's_uzi':
        // Same bank machine-gun sample, slightly hotter rate for the fast SMG.
        if (this.playBankSample(SFX.SHOT_SMG, 0.4 * gain, { rate: 1.06 })) return;
        // Faster/snappier variant: uzi pitched up further, trimmed even shorter.
        if (this.playSample('shot-uzi', 0.28 * gain, { rate: 1.95 + Math.random() * 0.2, maxDur: 0.12 })) return;
        if (!this.claimVoice(0.05)) return;
        this.noiseBurst({ t, dur: 0.045, peak: 0.36 * gain, type: 'lowpass', freq: 3200, freqEnd: 900, q: 0.7 });
        break;
      case 'silenced_s_uzi':
        // Original bank silenced SMG shot.
        if (this.playBankSample(SFX.SHOT_SILENCED_SMG, 0.35 * gain)) return;
        // Quiet suppressed 'phut': soft noise tick, low volume (synth fallback).
        if (!this.claimVoice(0.06)) return;
        this.noiseBurst({ t, dur: 0.05, peak: 0.12 * gain, attack: 0.001, type: 'lowpass', freq: 1300, freqEnd: 350, q: 0.6 });
        this.tone({ t, dur: 0.04, peak: 0.07 * gain, attack: 0.001, type: 'sine', freq: 170, freqEnd: 90 });
        break;
      case 'shotgun':
        // Original bank shotgun blast.
        if (this.playBankSample(SFX.SHOT_SHOTGUN, 0.6 * gain)) return;
        if (this.playSample('shot-shotgun', 0.6 * gain, { maxDur: 1.6 })) return;
        if (!this.claimVoice(0.35)) return;
        // Boomy and wide: low boom plus mid blast.
        this.noiseBurst({ t, dur: 0.32, peak: 0.7 * gain, type: 'lowpass', freq: 1000, freqEnd: 150, q: 0.9 });
        this.noiseBurst({ t, dur: 0.12, peak: 0.35 * gain, type: 'bandpass', freq: 1800, q: 0.5 });
        break;
      case 'rocket':
        // Original bank rocket-launcher fire.
        if (this.playBankSample(SFX.SHOT_ROCKET, 0.55 * gain)) return;
        // Launch whoosh: thruster sample trimmed short, else a noise sweep.
        if (this.playSample('rocket-launch', 0.55 * gain, { rate: 1.25 + Math.random() * 0.1, maxDur: 1.3 })) return;
        if (!this.claimVoice(0.6)) return;
        this.noiseBurst({ t, dur: 0.55, peak: 0.5 * gain, attack: 0.01, type: 'bandpass', freq: 400, freqEnd: 1800, q: 0.8 });
        this.noiseBurst({ t, dur: 0.4, peak: 0.3 * gain, attack: 0.005, type: 'lowpass', freq: 600, freqEnd: 150, q: 1 });
        break;
      case 'grenade':
      case 'molotov':
        // Soft throw whoosh, very quiet.
        if (!this.claimVoice(0.2)) return;
        this.noiseBurst({ t, dur: 0.18, peak: 0.07 * gain, attack: 0.05, type: 'bandpass', freq: 400, freqEnd: 900, q: 1.5 });
        break;
      case 'fists':
        if (!this.claimVoice(0.14)) return;
        // Soft whoosh + low thud.
        this.noiseBurst({ t, dur: 0.12, peak: 0.18 * gain, attack: 0.03, type: 'bandpass', freq: 500, freqEnd: 250, q: 1.5 });
        this.tone({ t, dur: 0.08, peak: 0.2 * gain, type: 'sine', freq: 110, freqEnd: 60 });
        break;
      // 'flamethrower' and 'electrogun' are continuous loops
      // (setFlamethrower/setElectro) and never emit 'shot' events.
    }
  }

  private playHit(gain: number, surface?: 'ped' | 'car' | 'wall'): void {
    const t = this.ctx!.currentTime;
    // Bullet on car body: original bank variants 62-64 (random of 3).
    if (surface === 'car') {
      const idx = SFX.BULLET_HIT_CAR_FIRST + Math.floor(Math.random() * SFX.BULLET_HIT_CAR_COUNT);
      if (this.playBankSample(idx, 0.45 * gain)) return;
    }
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

  /** Panicked burning scream: longer and wilder than the normal scream. */
  private playBurningScream(gain: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const dur = 0.85 + Math.random() * 0.2;
    if (!this.claimVoice(dur)) return;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const base = 650 + Math.random() * 250;
    // Rising panic, holding high, then collapsing.
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.exponentialRampToValueAtTime(base * 1.9, t + dur * 0.3);
    osc.frequency.exponentialRampToValueAtTime(base * 1.5, t + dur * 0.6);
    osc.frequency.exponentialRampToValueAtTime(160, t + dur);
    // Fast vibrato makes it read as a wail rather than a siren.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 11 + Math.random() * 4;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1200;
    filter.Q.value = 1.1;
    const g = this.envelope(t, 0.26 * gain, 0.03, dur);
    osc.connect(filter);
    filter.connect(g);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + dur + 0.02);
    lfo.stop(t + dur + 0.02);
  }

  private playDoor(gain: number, entering: boolean): void {
    const t = this.ctx!.currentTime;
    // Original bank car door: 26 = close (enter), 25 = open (exit).
    if (this.playBankSample(entering ? SFX.CAR_DOOR_CLOSE : SFX.CAR_DOOR_OPEN, 0.6 * gain)) return;
    // Entering slams the door shut; exiting pops it open. Subtle random pitch
    // so repeated car-jacking doesn't sound stamped from one mould.
    const rate = 0.94 + Math.random() * 0.12;
    if (this.playSample(entering ? 'door-close' : 'door-open', 0.6 * gain, { rate })) return;
    if (!this.claimVoice(0.12)) return;
    // Metallic clunk: low thump + brief mid rattle.
    const freq = (entering ? 140 : 170) * rate;
    this.tone({ t, dur: 0.09, peak: 0.3 * gain, attack: 0.002, type: 'sine', freq, freqEnd: freq * 0.5 });
    this.noiseBurst({ t: t + 0.01, dur: 0.05, peak: 0.12 * gain, type: 'bandpass', freq: 900, q: 4 });
  }

  private playCrash(gain: number, speed: number): void {
    const t = this.ctx!.currentTime;
    // Original bank impact: light (12) or heavy (13) picked by event speed,
    // plus a metal crunch layer (43-45 normal / 46-48 heavy) on hard hits.
    const heavy = speed >= CRASH_HEAVY_SPEED;
    if (this.playBankSample(heavy ? SFX.CAR_IMPACT_HEAVY : SFX.CAR_IMPACT_LIGHT, 0.8 * gain)) {
      if (speed >= CRASH_CRUNCH_SPEED) {
        const first = heavy ? SFX.CRASH_CRUNCH_HEAVY_FIRST : SFX.CRASH_CRUNCH_FIRST;
        this.playBankSample(first + Math.floor(Math.random() * SFX.CRASH_CRUNCH_COUNT), 0.55 * gain);
      }
      return;
    }
    // 3 randomized variants: random sample pick + rate jitter.
    const pick = CRASH_SAMPLES[Math.floor(Math.random() * CRASH_SAMPLES.length)];
    if (this.playSample(pick, 0.8 * gain, { rate: 0.85 + Math.random() * 0.3 })) return;
    if (!this.claimVoice(0.3)) return;
    // Metallic crunch: two resonant noise bands + low impact. Randomize the
    // band centers so synth crashes vary too.
    const f = 0.85 + Math.random() * 0.3;
    this.noiseBurst({ t, dur: 0.25, peak: 0.45 * gain, type: 'bandpass', freq: 2200 * f, freqEnd: 800 * f, q: 1.8 });
    this.noiseBurst({ t, dur: 0.2, peak: 0.4 * gain, type: 'bandpass', freq: 600 * f, freqEnd: 250 * f, q: 1.2 });
    this.tone({ t, dur: 0.12, peak: 0.3 * gain, attack: 0.002, type: 'sine', freq: 90, freqEnd: 45 });
  }

  private playExplosion(gain: number): void {
    const t = this.ctx!.currentTime;
    // Delayed debris: a quieter crackle/rattle shortly after the main blast.
    const debrisT = t + 0.28 + Math.random() * 0.12;
    this.noiseBurst({ t: debrisT, dur: 0.35, peak: 0.16 * gain, attack: 0.01, type: 'bandpass', freq: 1700, freqEnd: 450, q: 2.2 });
    this.noiseBurst({ t: debrisT + 0.07, dur: 0.22, peak: 0.1 * gain, attack: 0.01, type: 'bandpass', freq: 900, freqEnd: 300, q: 1.6 });
    // Original bank explosion (id 30, best acoustic candidate — the decomp's
    // explosion-audio path is a stub; see docs/gta2-reference.md §1). Keep the
    // CC0 low-frequency layer underneath for weight.
    if (this.playBankSample(SFX.EXPLOSION, 0.9 * gain)) {
      this.playSample('explosion-low', 0.7 * gain);
      return;
    }
    if (this.playSample('explosion-crunch', 0.9 * gain)) {
      // Layer a sub-bass thump under the crunch when available.
      this.playSample('explosion-low', 0.7 * gain);
      return;
    }
    if (!this.claimVoice(1.2)) return;
    // Big low boom with long decay + sub sine drop.
    this.noiseBurst({ t, dur: 1.1, peak: 0.9 * gain, attack: 0.005, type: 'lowpass', freq: 900, freqEnd: 80, q: 1 });
    this.tone({ t, dur: 0.8, peak: 0.6 * gain, attack: 0.005, type: 'sine', freq: 130, freqEnd: 30 });
  }

  /** Molotov hit: glass shatter + fire ignition whoosh. */
  private playMolotovSmash(gain: number): void {
    const t = this.ctx!.currentTime;
    // Ignition whoosh (always synth): rising airy noise that blooms into fire.
    this.noiseBurst({ t: t + 0.04, dur: 0.5, peak: 0.3 * gain, attack: 0.06, type: 'bandpass', freq: 500, freqEnd: 1600, q: 0.7 });
    this.noiseBurst({ t: t + 0.1, dur: 0.45, peak: 0.18 * gain, attack: 0.08, type: 'lowpass', freq: 700, freqEnd: 250, q: 1 });
    // Quiet bank break layer (40/41 — closest the SDT bank has to glass; the
    // CC0 glass-shatter below stays the primary smash sound).
    this.playBankSample(Math.random() < 0.5 ? SFX.GLASS_BREAK_SMALL : SFX.GLASS_BREAK_BIG, 0.25 * gain);
    if (this.playSample('glass-shatter', 0.7 * gain, { rate: 0.95 + Math.random() * 0.1 })) return;
    if (!this.claimVoice(0.3)) return;
    // Synth glass: bright resonant shards.
    this.noiseBurst({ t, dur: 0.18, peak: 0.4 * gain, attack: 0.001, type: 'highpass', freq: 3500, q: 1.5 });
    this.noiseBurst({ t: t + 0.03, dur: 0.22, peak: 0.25 * gain, attack: 0.001, type: 'bandpass', freq: 5200, freqEnd: 2800, q: 3 });
  }

  /** Short tire screech, volume scaled by intensity 0..1. */
  private playSkid(gain: number, intensity: number): void {
    const t = this.ctx!.currentTime;
    if (intensity <= 0.02) return;
    // Original bank tyre-skid loop (id 22) played as a short one-shot slice;
    // rate jitter stands in for the original's surface-dependent rate.
    if (this.playBankSample(SFX.SKID_LOOP, 0.45 * gain * intensity, { maxDur: 0.4, rate: 0.85 + Math.random() * 0.25 })) {
      return;
    }
    const dur = 0.25 + 0.2 * intensity;
    if (!this.claimVoice(dur)) return;
    // Falling resonant bandpass over noise reads as rubber losing grip.
    const start = 1900 + Math.random() * 500;
    this.noiseBurst({ t, dur, peak: 0.32 * gain * intensity, attack: 0.02, type: 'bandpass', freq: start, freqEnd: start * 0.42, q: 7 });
    // Faint broadband scrub underneath keeps it from sounding like a whistle.
    this.noiseBurst({ t, dur: dur * 0.8, peak: 0.08 * gain * intensity, attack: 0.02, type: 'highpass', freq: 900, q: 0.7 });
  }

  /** Car horn beep with a little random pitch. */
  private playHorn(gain: number): void {
    const t = this.ctx!.currentTime;
    const rate = 0.92 + Math.random() * 0.16;
    if (this.playSample('horn', 0.55 * gain, { rate })) return;
    if (!this.claimVoice(0.3)) return;
    // Synth fallback: two-tone square stab (classic dual-horn interval).
    this.tone({ t, dur: 0.28, peak: 0.14 * gain, attack: 0.01, type: 'square', freq: 370 * rate });
    this.tone({ t, dur: 0.28, peak: 0.12 * gain, attack: 0.01, type: 'square', freq: 466 * rate });
  }

  private playPickup(gain: number): void {
    const t = this.ctx!.currentTime;
    if (this.playSample('pickup', 0.5 * gain)) return;
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

  /**
   * Looping engine sample, pitched by playbackRate. Used for both the CC0
   * engine-loop WAV (key 'cc0', whole-buffer loop) and GTA2 bank engine
   * samples (key 'bank:<idx>', loop points from the SDT entry).
   */
  private createEngineSample(
    ctx: AudioContext,
    buf: AudioBuffer,
    key: string,
    loopPts: { start: number; end: number } | null,
    initialRate: number,
  ): void {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    if (loopPts) {
      src.loopStart = Math.min(loopPts.start, buf.duration);
      src.loopEnd = Math.min(loopPts.end, buf.duration);
    }
    src.playbackRate.value = initialRate;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain);
    gain.connect(this.master!);
    src.start();
    this.engineSrc = src;
    this.engineSrcGain = gain;
    this.engineSrcKey = key;
  }

  /** Fade out and dispose the sample engine loop (source handover). */
  private stopEngineSample(t: number): void {
    if (!this.engineSrc || !this.engineSrcGain) return;
    this.engineSrcGain.gain.setTargetAtTime(0, t, 0.05);
    try {
      this.engineSrc.stop(t + 0.4);
    } catch {
      // already stopped
    }
    this.engineSrc = null;
    this.engineSrcGain = null;
    this.engineSrcKey = null;
  }

  /** Fade out and dispose the synth engine (when handing over to the sample). */
  private stopSynthEngine(t: number): void {
    if (!this.engineOsc || !this.engineGain) return;
    this.engineGain.gain.setTargetAtTime(0, t, 0.05);
    this.engineOsc.stop(t + 0.4);
    this.engineLfo?.stop(t + 0.4);
    this.engineOsc = null;
    this.engineLfo = null;
    this.engineFilter = null;
    this.engineGain = null;
  }

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
    this.engineLfo = lfo;
    this.engineFilter = filter;
    this.engineGain = gain;
  }

  // ----- continuous synth loops --------------------------------------------

  /** Start a looping buffer source through a filter into `out`. */
  private loopSource(
    ctx: AudioContext,
    buf: AudioBuffer,
    out: AudioNode,
    opts: { type: BiquadFilterType; freq: number; q?: number; level: number; rate?: number },
  ): void {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    if (opts.rate !== undefined) src.playbackRate.value = opts.rate;
    // Random start phase so two loops from the same buffer don't correlate.
    const filter = ctx.createBiquadFilter();
    filter.type = opts.type;
    filter.frequency.value = opts.freq;
    filter.Q.value = opts.q ?? 1;
    const g = ctx.createGain();
    g.gain.value = opts.level;
    src.connect(filter);
    filter.connect(g);
    g.connect(out);
    src.start(0, Math.random() * buf.duration);
  }

  /** Flicker stage: unity gain wobbled by an LFO, feeding the loop's fader. */
  private flickerStage(ctx: AudioContext, out: AudioNode, rateHz: number, depth: number): GainNode {
    const stage = ctx.createGain();
    stage.gain.value = 1;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = rateHz;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = depth;
    lfo.connect(lfoGain);
    lfoGain.connect(stage.gain);
    lfo.start();
    stage.connect(out);
    return stage;
  }

  /** Roaring flame jet: mid-low rumble + hiss, with fast flicker. */
  private createFlameLoop(ctx: AudioContext): LoopVoice {
    const fader = ctx.createGain();
    fader.gain.value = 0;
    fader.connect(this.master!);
    const flicker = this.flickerStage(ctx, fader, 13, 0.22);
    this.loopSource(ctx, this.brownNoiseBuffer!, flicker, { type: 'lowpass', freq: 320, q: 0.8, level: 0.9 }); // rumble
    this.loopSource(ctx, this.noiseBuffer!, flicker, { type: 'bandpass', freq: 2300, q: 0.6, level: 0.28 }); // jet hiss
    this.loopSource(ctx, this.crackleSlow!, flicker, { type: 'bandpass', freq: 1500, q: 1, level: 0.35, rate: 1.3 }); // spitting
    return { gain: fader };
  }

  /** Electric crackle/buzz: gritty square hum + dense fizz. */
  private createElectroLoop(ctx: AudioContext): LoopVoice {
    const fader = ctx.createGain();
    fader.gain.value = 0;
    fader.connect(this.master!);
    const flicker = this.flickerStage(ctx, fader, 28, 0.3);
    // Mains-style buzz: two slightly detuned squares through a peaky bandpass.
    for (const freq of [110, 113.3]) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 750;
      filter.Q.value = 1.6;
      const g = ctx.createGain();
      g.gain.value = 0.16;
      osc.connect(filter);
      filter.connect(g);
      g.connect(flicker);
      osc.start();
    }
    this.loopSource(ctx, this.crackleFast!, flicker, { type: 'highpass', freq: 2400, q: 0.8, level: 0.85, rate: 1.1 }); // arcing fizz
    return { gain: fader };
  }

  /** Burning fire near the player: slow crackle pops over a soft low roar. */
  private createFireLoop(ctx: AudioContext): LoopVoice {
    const fader = ctx.createGain();
    fader.gain.value = 0;
    fader.connect(this.master!);
    const flicker = this.flickerStage(ctx, fader, 5, 0.25);
    this.loopSource(ctx, this.brownNoiseBuffer!, flicker, { type: 'lowpass', freq: 260, q: 0.7, level: 0.55 }); // low roar
    this.loopSource(ctx, this.crackleSlow!, flicker, { type: 'bandpass', freq: 1900, q: 1.2, level: 0.8, rate: 0.85 }); // pops
    this.loopSource(ctx, this.crackleSlow!, flicker, { type: 'highpass', freq: 3800, q: 0.7, level: 0.3, rate: 1.6 }); // fine sizzle
    return { gain: fader };
  }

  /**
   * Original GTA2 siren loop (bank id 14) with loop points from the SDT
   * entry. Returns null when no bank is attached or the entry is missing
   * (caller falls back to the synth two-tone wail below).
   */
  private createBankSirenLoop(ctx: AudioContext): LoopVoice | null {
    if (!this.bank) return null;
    const buf = this.bank.buffer(SFX.SIREN_LOOP);
    if (!buf) return null;
    const fader = ctx.createGain();
    fader.gain.value = 0;
    fader.connect(this.master!);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const pts = this.bank.loopSeconds(SFX.SIREN_LOOP);
    if (pts) {
      src.loopStart = Math.min(pts.start, buf.duration);
      src.loopEnd = Math.min(pts.end, buf.duration);
    }
    src.connect(fader);
    src.start();
    return { gain: fader };
  }

  /** Classic two-tone siren wail: oscillator swept by a slow LFO. */
  private createSirenLoop(ctx: AudioContext): LoopVoice {
    const fader = ctx.createGain();
    fader.gain.value = 0;
    fader.connect(this.master!);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 740;
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.45; // wail cycle
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 170; // sweep ±170 Hz
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 850;
    filter.Q.value = 1.1;
    osc.connect(filter);
    filter.connect(fader);
    osc.start();
    lfo.start();
    return { gain: fader };
  }

  /** Barely-audible city bed: low brown-noise wind/rumble, slowly breathing. */
  private createAmbienceLoop(ctx: AudioContext): LoopVoice {
    const fader = ctx.createGain();
    fader.gain.value = 0;
    fader.connect(this.master!);
    const breathe = this.flickerStage(ctx, fader, 0.07, 0.3);
    this.loopSource(ctx, this.brownNoiseBuffer!, breathe, { type: 'lowpass', freq: 190, q: 0.5, level: 0.9 }); // wind/rumble
    this.loopSource(ctx, this.noiseBuffer!, breathe, { type: 'bandpass', freq: 950, q: 0.4, level: 0.018 }); // distant hiss
    return { gain: fader };
  }
}

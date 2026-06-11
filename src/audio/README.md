Hybrid audio system, three tiers: **original GTA2 bank samples** (when a `Gta2Bank` is attached via `attachBank()`), real CC0 samples (`public/sounds/`, ~1.1 MB total), and fully-synthesized Web Audio paths as the last fallback (and the only path for sounds with no fitting sample).
`AudioManager.init()` (user gesture) creates the context and kicks off a non-blocking fetch+`decodeAudioData` of every CC0 sample; each trigger plays the best available source: bank entry → decoded CC0 `AudioBuffer` → synth.
Sim `GameEvent`s map to one-shot voices with smoothstep distance falloff (radius 600), an 8-voice polyphony cap (long sample tails are trimmed with a quick fade so capped voices free up), and 30ms per-event rate limiting (`skid` uses 150ms, footsteps 250ms).
All parameter changes use ramps to avoid clicks, and every public method is a no-op before `init()`.

GTA2 bank: `attachBank(bank)` takes a `Gta2Bank` (src/audio/gta2bank.ts) parsed from the district's `*.sdt`+`*.raw` pair. Bank ids live in `src/audio/gta2-sfx.ts`; the definitive id table (from the gta2_re decompilation) is docs/gta2-reference.md §1. Bank one-shots always apply the SDT entry's own pitch variation (`Gta2Bank.playbackRate`), matching the original engine. When no bank is attached — or a given entry is missing — every trigger falls back to the CC0/synth behavior below unchanged.

Continuous loops (all lazily created, faded with smooth `setTargetAtTime` ramps):

- `setEngine(active, speedRatio)` — **bank**: when `setEngineClass(cls)` has set a bank engine sample id (3-8, per vehicle class; callers compute it from the car model), a looping source with the SDT loop points, `playbackRate` 0.75 (idle) → 1.5 (full speed). Otherwise: once `engine-loop.wav` is decoded, a looping `AudioBufferSourceNode` pitched via `playbackRate` 0.6→1.6; until then a sawtooth-through-lowpass synth engine (70-220Hz with LFO wobble). All handovers (synth↔CC0↔bank) are faded.
- `setSiren(intensity)` — **bank id 14** looped with SDT loop points, gain follows intensity 0..1; synth two-tone wail (triangle swept by 0.45Hz LFO) as fallback.
- `setFlamethrower(active)` — synth flame jet: brown-noise rumble (lowpass 320) + jet hiss (bandpass 2300) + spitting crackle, under a 13Hz flicker LFO.
- `setElectro(active)` — synth electric buzz: two detuned squares (110/113.3Hz) through a peaky bandpass + dense high-passed impulse fizz, 28Hz flicker.
- `setFireNearby(intensity)` — burning crackle: low brown-noise roar + slow impulse pops + fine sizzle; gain follows intensity 0..1 smoothly (5Hz flicker).
- `setAmbience(active)` — barely-audible city bed: low-passed brown noise wind/rumble + faint distant hiss, breathing on a 0.07Hz LFO.
- `setCrowd(intensity)` — while > 0, a random bank ped-chatter sample (233-238) every 2-6s (more often at higher intensity) at volume (0.05-0.12)×intensity. Bank only (no CC0/synth chatter).

One-shot extras:

- `playFootstep(running)` — bank pavement footsteps 198-201 (random of 4), volume 0.08 walking / 0.2 running, ±5% rate, rate-limited to 250ms. Bank only.

Synth textures come from three precomputed buffers: white noise, brown (integrated) noise, and sparse-impulse "crackle" buffers (low density for fire, high density for electricity).

## Sample mapping (event → bank id → fallback)

Bank ids from docs/gta2-reference.md §1 (gta2_re `sound_obj.cpp`); constants in `src/audio/gta2-sfx.ts`. CC0 sources have full provenance in `assets-raw/ATTRIBUTION.md`.

| Trigger | GTA2 bank (primary) | CC0/synth fallback |
|---|---|---|
| `shot` (pistol, dual_pistol) | **311** (SDT pitch variation) | `shot-pistol.wav` (OGA "Gunshots" by LarkPay), then synth crack |
| `shot` (uzi, s_uzi) | **312** (s_uzi rate ×1.06) | `shot-uzi.wav` (LarkPay `22 Magnum.wav`, pitched/trimmed), then synth |
| `shot` (silenced_s_uzi) | **313** | synth suppressed 'phut' |
| `shot` (shotgun) | **314** | `shot-shotgun.wav` (LarkPay `Black Powder.wav`), then synth boom |
| `shot` (rocket) | **315** | `rocket-launch.ogg` (Kenney Sci-Fi), then synth noise sweep |
| `shot` (grenade, molotov) | — | synth-only quiet throw whoosh |
| `shot` (fists) | — | synth-only whoosh + thud |
| `shot` (flamethrower, electrogun) | never emitted — loops (`setFlamethrower` / `setElectro`) | — |
| `explosion` | **30** (best acoustic candidate; decomp path is a stub) + CC0 `explosion-low.ogg` layered underneath for weight | `explosion-crunch.ogg` + `explosion-low.ogg` (Kenney), then synth boom; synth delayed debris crackle always added |
| `car_crash` | **12** light / **13** heavy by event speed; + crunch **43-45** (normal) or **46-48** (heavy) on hard hits | random `crash-metal{,2,3}.ogg` (Kenney Impact), then synth crunch |
| `hit` (surface `car`) | random of **62-64** | synth tick + thump |
| `hit` (other surfaces) | — | synth tick + thump |
| `molotov_smash` | quiet **40**/**41** break layer added (bank has no clear glass id) | `glass-shatter.ogg` (Kenney Impact) stays primary, then synth shards; synth ignition whoosh always added |
| `skid` | **22** (loop sample, played as a ≤0.4s one-shot slice, rate 0.85-1.10) | synth falling resonant bandpass; rate-limited to 150ms |
| `car_enter` | **26** (door close) | `door-close.ogg` (OGA ggbotnet), then synth clunk |
| `car_exit` | **25** (door open) | `door-open.ogg` (OGA ggbotnet), then synth clunk |
| `horn` | — (kept CC0) | `horn.ogg` (OGA ggbotnet), then synth two-tone stab |
| `pickup` | — (not referenced in the decomp) | `pickup.ogg` (Kenney Interface), then synth blip |
| `uiClick()` | — | `ui-click.ogg` (Kenney Interface), then synth blip |
| engine (`setEngine` + `setEngineClass`) | **3-8** by vehicle class, SDT loop points, rate 0.75→1.5 | `engine-loop.wav` (OGA domasx2, rate 0.6→1.6), then synth sawtooth engine |
| siren (`setSiren`) | **14** looped (SDT loop points) | synth two-tone wail |
| `playFootstep()` | **198-201** (random of 4) | — (silent without bank) |
| `setCrowd()` chatter | **233-238** (random of 6) | — (silent without bank) |
| `ped_scream`, `ped_killed`, `ped_on_fire`, `player_died`, `hit` on peds | — (the original routes voices to a separate vocal stream bank we don't ship) | synth-only pitch-sweep screams etc. |
| `setFlamethrower`, `setElectro`, `setFireNearby`, `setAmbience` | — | synth loops only, see above |

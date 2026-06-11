Hybrid audio system: real CC0 samples (`public/sounds/`, ~1.1 MB total) with fully-synthesized Web Audio paths as fallback (and as the only path for sounds with no fitting sample).
`AudioManager.init()` (user gesture) creates the context and kicks off a non-blocking fetch+`decodeAudioData` of every sample; each trigger plays the decoded `AudioBuffer` when ready, otherwise the synth version.
Sim `GameEvent`s map to one-shot voices with smoothstep distance falloff (radius 600), an 8-voice polyphony cap (long sample tails are trimmed with a quick fade so capped voices free up), and 30ms per-event rate limiting (`skid` uses 150ms).
All parameter changes use ramps to avoid clicks, and every public method is a no-op before `init()`.

Continuous loops (all lazily created, faded with smooth `setTargetAtTime` ramps):

- `setEngine(active, speedRatio)` — once `engine-loop.wav` is decoded, a looping `AudioBufferSourceNode` pitched via `playbackRate` 0.6→1.6; until then a sawtooth-through-lowpass synth engine (70-220Hz with LFO wobble), faded out on handover.
- `setFlamethrower(active)` — synth flame jet: brown-noise rumble (lowpass 320) + jet hiss (bandpass 2300) + spitting crackle, under a 13Hz flicker LFO.
- `setElectro(active)` — synth electric buzz: two detuned squares (110/113.3Hz) through a peaky bandpass + dense high-passed impulse fizz, 28Hz flicker.
- `setFireNearby(intensity)` — burning crackle: low brown-noise roar + slow impulse pops + fine sizzle; gain follows intensity 0..1 smoothly (5Hz flicker).
- `setAmbience(active)` — barely-audible city bed: low-passed brown noise wind/rumble + faint distant hiss, breathing on a 0.07Hz LFO.

Synth textures come from three precomputed buffers: white noise, brown (integrated) noise, and sparse-impulse "crackle" buffers (low density for fire, high density for electricity).

## Sample mapping (event → file → source)

All sources are CC0 1.0; full provenance in `assets-raw/ATTRIBUTION.md`.

| Trigger | File (`public/sounds/`) | Source |
|---|---|---|
| `shot` (pistol) | `shot-pistol.wav` (rate 0.96-1.04) | OGA "Gunshots" by LarkPay — `22 Pistol.wav`, downsampled 96k stereo → 44.1k 16-bit mono |
| `shot` (dual_pistol) | `shot-pistol.wav` (rate 0.92-1.08, slightly louder) | same as pistol |
| `shot` (uzi) | `shot-uzi.wav` | OGA "Gunshots" by LarkPay — `22 Magnum.wav` (same downsample), played pitched up (~1.55-1.7x) and trimmed to 0.18s |
| `shot` (s_uzi) | `shot-uzi.wav` (rate 1.95-2.15, trimmed to 0.12s) | same as uzi — snappier variant |
| `shot` (silenced_s_uzi) | — (synth only) | suppressed 'phut': soft lowpassed noise tick + tiny sine thump, low volume |
| `shot` (shotgun) | `shot-shotgun.wav` | OGA "Gunshots" by LarkPay — `Black Powder.wav` (same downsample), tail trimmed to 1.6s |
| `shot` (rocket) | `rocket-launch.ogg` (rate ~1.3, trimmed to 1.3s) | Kenney Sci-Fi Sounds — `thrusterFire_000.ogg` |
| `shot` (grenade, molotov) | — (synth only) | very quiet rising bandpass noise whoosh (throw) |
| `shot` (fists) | — (synth only) | — |
| `shot` (flamethrower, electrogun) | never emitted — these are loops (`setFlamethrower` / `setElectro`) | — |
| `explosion` | `explosion-crunch.ogg` + `explosion-low.ogg` layered, plus synth delayed debris crackle ~0.3s after | Kenney Sci-Fi Sounds — `explosionCrunch_000.ogg`, `lowFrequency_explosion_000.ogg` |
| `car_crash` | random pick of `crash-metal.ogg` / `crash-metal2.ogg` / `crash-metal3.ogg` (rate 0.85-1.15) | Kenney Impact Sounds — `impactMetal_heavy_000/001/003.ogg` |
| `molotov_smash` | `glass-shatter.ogg` (rate 0.95-1.05) + synth fire-ignition whoosh | Kenney Impact Sounds — `impactGlass_medium_000.ogg` |
| `horn` | `horn.ogg` (rate 0.92-1.08) | OGA "Car Sound Effects Pack" by ggbotnet — `Car_Horn.ogg` |
| `skid` | — (synth only) | falling resonant bandpass noise (Q≈7) + faint highpass scrub; volume × intensity; rate-limited to 150ms |
| `car_enter` | `door-close.ogg` (rate 0.94-1.06) | OGA "Car Sound Effects Pack" by ggbotnet — `Car_Door_Close.ogg` |
| `car_exit` | `door-open.ogg` (rate 0.94-1.06) | OGA "Car Sound Effects Pack" by ggbotnet — `Car_Door_Open.ogg` |
| `pickup` | `pickup.ogg` | Kenney Interface Sounds — `confirmation_001.ogg` |
| `uiClick()` | `ui-click.ogg` | Kenney Interface Sounds — `click_001.ogg` |
| engine (`setEngine`) | `engine-loop.wav` (seamless loop, `playbackRate` 0.6→1.6) | OGA "Racing car engine sound loops" by domasx2 — `loop_2_0.wav` (mid RPM) |
| `hit`, `ped_scream`, `ped_killed`, `ped_on_fire`, `player_died` | — (synth only; no fitting CC0 sample) | `ped_on_fire` is a longer, wilder pitch-sweep scream with fast vibrato |
| `setFlamethrower`, `setElectro`, `setFireNearby`, `setAmbience` | — (synth loops only) | see loop descriptions above |

Hybrid audio system: real CC0 samples (`public/sounds/`, ~880 KB total) with the original fully-synthesized Web Audio paths as fallback.
`AudioManager.init()` (user gesture) creates the context and kicks off a non-blocking fetch+`decodeAudioData` of every sample; each trigger plays the decoded `AudioBuffer` when ready, otherwise the synth version.
Sim `GameEvent`s map to one-shot voices with smoothstep distance falloff (radius 600), an 8-voice polyphony cap (long sample tails are trimmed with a quick fade so capped voices free up), and 30ms per-event rate limiting.
Engine: once `engine-loop.wav` is decoded, a looping `AudioBufferSourceNode` is pitched via `playbackRate` 0.6→1.6 from `speedRatio` (smooth `setTargetAtTime` ramps); until then the original sawtooth-through-lowpass synth engine (70-220Hz with LFO wobble) runs and is faded out on handover. All parameter changes use ramps to avoid clicks, and everything is a no-op before `init()`.

## Sample mapping (event → file → source)

All sources are CC0 1.0; full provenance in `assets-raw/ATTRIBUTION.md`.

| Trigger | File (`public/sounds/`) | Source |
|---|---|---|
| `shot` (pistol) | `shot-pistol.wav` | OGA "Gunshots" by LarkPay — `22 Pistol.wav`, downsampled 96k stereo → 44.1k 16-bit mono |
| `shot` (uzi) | `shot-uzi.wav` | OGA "Gunshots" by LarkPay — `22 Magnum.wav` (same downsample), played pitched up (~1.3x) and trimmed to 0.3s |
| `shot` (shotgun) | `shot-shotgun.wav` | OGA "Gunshots" by LarkPay — `Black Powder.wav` (same downsample), tail trimmed to 1.6s |
| `shot` (fists) | — (synth only) | — |
| `explosion` | `explosion-crunch.ogg` + `explosion-low.ogg` layered | Kenney Sci-Fi Sounds — `explosionCrunch_000.ogg`, `lowFrequency_explosion_000.ogg` |
| `car_crash` | `crash-metal.ogg` (random rate 0.9-1.1) | Kenney Impact Sounds — `impactMetal_heavy_000.ogg` |
| `car_enter` | `door-close.ogg` | OGA "Car Sound Effects Pack" by ggbotnet — `Car_Door_Close.ogg` |
| `car_exit` | `door-open.ogg` | OGA "Car Sound Effects Pack" by ggbotnet — `Car_Door_Open.ogg` |
| `pickup` | `pickup.ogg` | Kenney Interface Sounds — `confirmation_001.ogg` |
| `uiClick()` | `ui-click.ogg` | Kenney Interface Sounds — `click_001.ogg` |
| engine (`setEngine`) | `engine-loop.wav` (seamless loop, `playbackRate` 0.6→1.6) | OGA "Racing car engine sound loops" by domasx2 — `loop_2_0.wav` (mid RPM) |
| `hit`, `ped_scream`, `ped_killed`, `player_died` | — (synth only; no fitting CC0 sample) | — |

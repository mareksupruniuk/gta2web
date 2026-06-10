Fully synthesized Web Audio system (no asset files): a shared white-noise buffer plus oscillators feed filter/envelope chains into a single master gain.
`AudioManager` maps sim `GameEvent`s to one-shot voices with smoothstep distance falloff (radius 600), an 8-voice polyphony cap, and 30ms per-event rate limiting.
A persistent sawtooth-through-lowpass engine loop (70-220Hz with LFO wobble) follows `speedRatio`; all parameter changes use ramps to avoid clicks, and everything is a no-op before `init()`.

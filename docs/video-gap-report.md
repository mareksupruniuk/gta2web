# Reference-video gap report

Source: youtu.be/7-UnJevhWzA — "GTA 2 Downtown 100%" speedrun, 640×480 native,
75 min. Frames extracted at /tmp/gta2ref (303 survey frames + dense bursts
around explosions, fires, frenzies, tank). Second reference video
(youtu.be/xjGgHlbQ4YA) pending analysis.

## Confirmed original look/behavior (from frames)

### Explosions (closeup/exp08..20)
- Bright white-yellow core fireball with orange rim, ~1.5 car lengths wide.
- **Burning debris streaks**: orange comet-like particles with trails fly far
  (half a screen) from the blast in all directions, arcing.
- Chained secondary explosions on nearby cars.
- Burnt-out black husk wreck remains, on fire for a while.

### Skid marks (closeup/fire05, many survey frames)
- Persistent dark decals on the road: **two parallel curved lines** behind the
  tires during handbrake turns/slides. Stay visible long after.

### Shadows
- Cars cast a **drop shadow offset down-right ~3px** (screen space).
  Lampposts and overhead props cast long diagonal shadows.

### Score popups
- Huge green LCD-style digits (50/150/200/900) appear **in world space**
  behind the action, fading out (e.g. cop car crush "900").

### Big text
- KILL FRENZY!, FRENZY PASSED!, JOB COMPLETE!, COP CAR CRUSH!, BANK ROBBERY!
  — yellow caps with dark red outline, centered upper third.
- Mission/instruction text bottom: white with **colored keywords**
  (blue numbers, green nouns).
- Zone name on entry: **yellow plaque bar, black caps text**, top center
  ("ALTAMOUNT", "UNIVERSITY", "FRUITBAT").

### HUD (top corners)
- Left: pager icon, lives "Z"-icons, multiplier, **money in green LCD frame**.
- Right: row of **red hearts** (health), armor shields below, weapon icon
  with ammo digits, kill-frenzy panel (green, weapon icon + countdown),
  wanted level = small cop heads.

### Driving feel (video, throughout)
- Cars accelerate hard, top speed high (cop car 0.415 tiles/tick = 12.45
  blocks/s — nearly 2× our current 7.0 max).
- Handbrake produces controllable long slides with skid marks + squeal.
- Sharp snappy steering at low speed; wide arcs at speed.
- Car-car collisions shunt the lighter car (mass-based).

### Misc world detail
- Traffic stops at red lights? (cars queue at junctions), parked cars along
  curbs, peds scatter visibly, tank crushes cars (frenzy reward).
- Pickups pulse/blink on ground.

## Gaps vs our build

| # | Gap | Severity |
|---|-----|----------|
| 1 | No per-model handling (gci) — uniform tiers, too slow top speed | high |
| 2 | Explosion: no debris streaks, no chaining emphasis, no husk persistence styling | high |
| 3 | No skid mark decals | high |
| 4 | No sprite drop shadows | high |
| 5 | HUD is plain text, not GTA2-style (hearts/LCD money/cop heads/icons) | high |
| 6 | No world-space score popups | med |
| 7 | Big-text style (yellow/red outline) + zone plaque missing | med |
| 8 | No muzzle flash sprite; tracers too faint vs original | med |
| 9 | Damaged car smoke (gray puffs) before fire missing | med |
| 10 | Sounds: explosion boom, pickup chime, frenzy/job jingles, screams, score tick | high |
| 11 | Texture spot-check at video locations (road line continuity) | med |

## Second video (youtu.be/xjGgHlbQ4YA, 91 min, mission playthrough at dusk)

- GTA2's dusk lighting mode: colored static light pools (street lamps, neon),
  car headlight cones, much darker ambient. Optional flourish for us.
- Mission dialogue: bottom text bar with **boss portrait icon** on the left,
  typewriter text, colored keywords — reference for task #33 (missions).
- Confirms world-space green LCD score popups ("600") and yellow zone plaques
  ("FLOTSAM") in all modes.
- Missions flow: answer phone in gang turf → text instructions → drive/kill/
  deliver objectives → JOB COMPLETE! + cash.

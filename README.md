# GTA2WEB — Downtown District

A browser port of GTA2's Downtown district that renders the **real game data**
from the official freeware release: the original map, tiles, sprites, palettes
and traffic network, drawn with a perspective camera looking straight down —
the same trick that gives GTA2 its 2.5D look, with building walls leaning away
from the screen centre.

Built with three.js (WebGL) + TypeScript + Vite. Free roaming on foot or
behind the wheel, AI traffic driving the map's actual green-arrow road
network, pedestrians, weapons, explosions and sound.

> GTA2 was released as freeware by Rockstar Games in 2004. The game data is
> downloaded from that release for personal use and is **not** committed to
> this repository — do not redistribute builds containing it. Not affiliated
> with Rockstar Games.

## Run

```sh
npm install
./scripts/fetch-gamedata.sh   # downloads the GTA2 freeware data (needs: brew install sevenzip)
ln -sfn ../gamedata public/gamedata
npm run dev                   # then open the printed URL
```

- `npm test` — unit tests (vitest), including parser tests against the real data
- `npm run build` — production build
- `node scripts/verify.mjs` — headless-browser smoke test (dev server on port 5179)

## Controls (GTA2 style)

| Key | Action |
| --- | --- |
| ← / → (A/D) | rotate / steer |
| ↑ / ↓ (W/S) | walk, accelerate / back, brake |
| SPACE | attack on foot, handbrake in car |
| ENTER or F | enter / exit / carjack |
| Q / E | switch weapon |
| ESC | pause menu |

Weapons and health pickups (the original rotating sprites) lie on pavements
near your spawn.

## Architecture

```
src/
  gta2/     real-data pipeline (pure TS, unit-tested in node)
    reader.ts    chunked binary reader (GBMP/GBST files)
    gmp.ts       map parser: DMAP compressed columns, block_info bit fields,
                 zones (restart points, district names), tile animations
    sty.ts       style parser: physical/virtual palettes, 64x64 tiles,
                 sprites, car metadata + colour remaps
    slopes.ts    the 64-entry slope geometry table (26°/7°/45°, diagonals)
    atlas.ts     packs all 992 tiles into one 2048² RGBA atlas
    citymesh.ts  block columns → chunked triangle soup (lids, walls, slopes,
                 diagonals, per-lid lighting, animated-tile resolution)
  game2/    gameplay simulation in block units (1 block = 1.0)
    citymap.ts   collision & navigation: wall-flag crossing tests,
                 bridge-aware ground heights, ground types, green arrows
    car2.ts      arcade car physics; handling derived from car ratings
    ped2.ts      pedestrians wandering pavements, panicking, fleeing
    traffic2.ts  AI drivers following the map's green-arrow network
    world2.ts    orchestration: enter/exit/carjack, bullets, run-overs,
                 chained explosions, pickups, local-radius population
    weapons2.ts  pistol/uzi/shotgun/fists + inventory
  render3d/ three.js renderer: chunked city meshes, STY sprite quads with
            palette remaps, fx (muzzle/blood/explosions), chase camera with
            speed zoom + look-ahead
  audio/    WebAudio: CC0 samples (public/sounds) + synth fallback,
            engine loop pitched by speed, positional attenuation
  debug/    /debug.html — visual inspector for tiles/sprites/palettes/map
```

The simulation emits events (`shot`, `explosion`, `car_crash`, ...) consumed
by the renderer and audio layers; positions are in blocks, scaled at the
boundaries.

District files: `wil` = Downtown, `ste` = Residential, `bil` = Industrial.
Switching district = changing two file names in `src/main.ts`.

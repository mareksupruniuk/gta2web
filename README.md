# GTA2WEB — Downtown District

A GTA2-style top-down action game for the browser: one city district, free
roaming on foot or behind the wheel, living traffic and pedestrians, weapons,
explosions and sound. Built with PixiJS (WebGL), TypeScript and Vite.

This is an original homage — all graphics are procedurally generated and all
sound samples are CC0 (see `assets-raw/ATTRIBUTION.md`). Not affiliated with
Rockstar Games.

## Run

```sh
npm install
npm run dev      # then open the printed URL
```

- `npm test` — unit tests for the simulation (vitest)
- `npm run build` — production build into `dist/`
- `node scripts/verify.mjs` — headless-browser smoke test (needs the dev
  server on port 5179: `npm run dev -- --port 5179`)

## Controls

| Key | Action |
| --- | --- |
| WASD / arrows | walk / drive |
| SPACE | attack (on foot) / handbrake (in car) |
| ENTER or F | enter / exit (or carjack) a car |
| Q / E | previous / next weapon |
| ESC | pause menu |

Weapons (pistol, uzi, shotgun) and health lie on sidewalks around the city.
Score goes up for, well, the usual GTA things.

## Architecture

```
src/
  sim/      pure-TypeScript simulation, no DOM/Pixi — fully unit-testable
    map.ts      deterministic "Downtown" generator: island, two-lane road
                grid with right-hand traffic-flow data, buildings, parks
    car.ts      arcade car physics (lateral grip, handbrake drift, damage)
    traffic.ts  lane-following AI drivers (turns at intersections, brakes
                for obstacles)
    ped.ts      pedestrians: sidewalk wandering, panic/flee, jaywalking
    weapons.ts  weapon defs, bullets, ammo inventory
    world.ts    orchestration: collisions, run-overs, explosions (chained),
                pickups, respawning population; emits GameEvents
  render/   PixiJS renderer — tile map baked to one texture, sprite pools,
            camera with speed zoom and shake; all sprites generated on
            canvas at runtime (sprites.ts)
  audio/    WebAudio: CC0 samples (public/sounds) with full synthesized
            fallback; engine loop pitched by speed; positional attenuation
  core/     keyboard input with edge-triggered actions
  main.ts   menu/HUD wiring and fixed-timestep game loop (60 Hz sim)
```

The simulation emits events (`shot`, `explosion`, `car_crash`, ...) that the
renderer and audio layers consume — they never reach into each other.

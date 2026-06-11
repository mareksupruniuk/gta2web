import { AudioManager } from './audio/audio';
import { Input } from './core/input';
import { CityMap } from './game2/citymap';
import { Pickup, PlayerInput, World2 } from './game2/world2';
import { parseGmp } from './gta2/gmp';
import { parseSty, Sty } from './gta2/sty';
import { CityRenderer, FxSpawn, RenderEntity } from './render3d/renderer3d';
import { GameEvent } from './sim/types';

const FIXED_DT = 1 / 60;
const MAX_FRAME = 0.1;
const PX = 64; // audio tuning is in GTA2 pixels; sim runs in blocks

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const menuEl = $('menu');
const hudEl = $('hud');
const msgEl = $('msg');
const btnStart = $<HTMLButtonElement>('btn-start');
const btnControls = $<HTMLButtonElement>('btn-controls');
const btnSound = $<HTMLButtonElement>('btn-sound');
const controlsPanel = $('controls-panel');

const audio = new AudioManager();
const input = new Input();
input.attach();

let world: World2 | null = null;
let renderer: CityRenderer | null = null;
let sty: Sty | null = null;
let paused = true;
let starting = false;
let accumulator = 0;
let respawnTimer = 0;
let msgTimer = 0;
let lastArea: string | null = null;
let rafId = 0;
let lastT = 0;

// Sprite numbering within the style file (bases are cumulative counts).
let PED_SPRITE_BASE = 0;
let OBJ_SPRITE_BASE = 0;
const PED_WALK_FRAMES = 8;
const PED_ARMED_BASE = 8; // aiming/armed walk cycle
const PED_CORPSE_FRAME = 97; // sprawled-on-back death pose
const PICKUP_SPRITES: Record<Pickup['kind'], number> = {
  pistol: 18,
  uzi: 28,
  shotgun: 35,
  health: 10,
};

function showMsg(text: string, seconds = 2.5): void {
  msgEl.textContent = text;
  msgEl.style.opacity = '1';
  msgTimer = seconds;
}

function updateHud(w: World2): void {
  $('hud-health').textContent = String(Math.max(0, Math.ceil(w.player.health)));
  $('hud-weapon').textContent = w.player.car ? 'DRIVING' : w.player.inventory.currentDef().name;
  const ammo = w.player.inventory.currentAmmo();
  $('hud-ammo').textContent = !w.player.car && Number.isFinite(ammo) ? `× ${ammo}` : '';
  $('hud-score').textContent = String(w.player.score);
}

function openMenu(): void {
  paused = true;
  menuEl.classList.remove('hidden');
  hudEl.classList.remove('visible');
  btnStart.textContent = world ? 'RESUME' : 'PLAY';
}

function closeMenuAndPlay(): void {
  if (starting) return;
  audio.init();
  audio.uiClick();
  if (!world) {
    void startGame();
    return;
  }
  menuEl.classList.add('hidden');
  hudEl.classList.add('visible');
  paused = false;
}

async function startGame(): Promise<void> {
  starting = true;
  btnStart.textContent = 'LOADING…';
  try {
    // ?map=ste / ?map=bil loads the other districts (default: Downtown).
    const district = new URLSearchParams(location.search).get('map') ?? 'wil';
    const [gmpBuf, styBuf] = await Promise.all([
      fetch(`gamedata/${district}.gmp`).then((r) => {
        if (!r.ok) throw new Error(`${district}.gmp missing — put GTA2 data files in gamedata/`);
        return r.arrayBuffer();
      }),
      fetch(`gamedata/${district}.sty`).then((r) => {
        if (!r.ok) throw new Error(`${district}.sty missing — put GTA2 data files in gamedata/`);
        return r.arrayBuffer();
      }),
    ]);
    sty = parseSty(styBuf);
    PED_SPRITE_BASE = sty.spriteBase.car;
    OBJ_SPRITE_BASE = sty.spriteBase.car + sty.spriteBase.ped;
    const map = new CityMap(parseGmp(gmpBuf));
    // Spawn outside the Jesus Saves church in Avalon (north-west Downtown).
    world = new World2(map, sty, 1999, district === 'wil' ? { x: 9.5, y: 14.5 } : undefined);
    (window as unknown as { __world: World2 }).__world = world; // debug/test hook
    renderer = CityRenderer.create($('game'), map.gmp, sty);
    (window as unknown as { __renderer: CityRenderer }).__renderer = renderer;

    menuEl.classList.add('hidden');
    hudEl.classList.add('visible');
    paused = false;
    lastT = performance.now();
    rafId = requestAnimationFrame(tick);
    showMsg('Welcome to Downtown. ENTER steals a car.', 4);
  } catch (e) {
    btnStart.textContent = 'PLAY';
    showMsg(e instanceof Error ? e.message : String(e), 6);
    throw e;
  } finally {
    starting = false;
  }
}

const pending = { enterExit: false, nextWeapon: false, prevWeapon: false, jump: false };

function readInput(): PlayerInput {
  pending.enterExit ||= input.wasPressed('Enter', 'KeyF');
  pending.nextWeapon ||= input.wasPressed('KeyE');
  pending.prevWeapon ||= input.wasPressed('KeyQ');
  pending.jump ||= input.wasPressed('ShiftLeft', 'ShiftRight', 'KeyX');
  return {
    moveX: input.moveX(),
    moveY: input.moveY(),
    attack: input.isDown('Space') || input.wasPressed('Space'),
    jump: pending.jump,
    enterExit: pending.enterExit,
    nextWeapon: pending.nextWeapon,
    prevWeapon: pending.prevWeapon,
  };
}

/** Ground slope gradient at (x, y), for tilting sprites on hills. */
function gradAt(w: World2, x: number, y: number, z: number): { dzdx: number; dzdy: number } {
  const e = 0.2;
  const g = (xx: number, yy: number): number => w.map.groundZ(xx, yy, z + 0.6) ?? z;
  return {
    dzdx: (g(x + e, y) - g(x - e, y)) / (2 * e),
    dzdy: (g(x, y + e) - g(x, y - e)) / (2 * e),
  };
}

function entities(w: World2): RenderEntity[] {
  const out: RenderEntity[] = [];
  const s = sty!;
  for (const car of w.cars) {
    out.push({
      key: `car:${car.id}`,
      sprite: car.info.spriteIdx,
      remapPhys: car.remap >= 0 ? s.carRemapPalette(car.remap) : undefined,
      tint: car.exploded ? 0x3a3a3a : undefined,
      x: car.pos.x, y: car.pos.y, z: car.z + 0.05,
      angle: car.heading,
      ...gradAt(w, car.pos.x, car.pos.y, car.z),
    });
  }
  for (const ped of w.peds) {
    const frame = ped.dead
      ? PED_CORPSE_FRAME
      : Math.floor(ped.animTime * 10) % PED_WALK_FRAMES;
    out.push({
      key: `ped:${ped.id}`,
      sprite: PED_SPRITE_BASE + frame,
      remapPhys: ped.remap >= 0 ? s.pedRemapPalette(ped.remap) : undefined,
      x: ped.pos.x, y: ped.pos.y, z: ped.z + (ped.dead ? 0.02 : 0.03),
      angle: ped.heading,
      ...(ped.dead ? {} : gradAt(w, ped.pos.x, ped.pos.y, ped.z)),
    });
  }
  const p = w.player;
  if (!p.car && !p.dead) {
    // Armed stance (aiming cycle) when holding a weapon, plain walk otherwise.
    const armed = p.inventory.current !== 'fists';
    const base = armed ? PED_ARMED_BASE : 0;
    const frame = p.moving ? base + (Math.floor(p.animTime * 10) % PED_WALK_FRAMES) : base;
    out.push({
      key: 'player',
      sprite: PED_SPRITE_BASE + frame,
      x: p.pos.x, y: p.pos.y, z: p.z + 0.035,
      angle: p.heading,
      ...gradAt(w, p.pos.x, p.pos.y, p.z),
    });
  }
  w.pickups.forEach((pk, i) => {
    if (pk.respawnIn > 0) return;
    out.push({
      key: `pickup:${i}`,
      sprite: OBJ_SPRITE_BASE + PICKUP_SPRITES[pk.kind],
      x: pk.pos.x, y: pk.pos.y, z: pk.z + 0.04,
      angle: w.time * 1.5,
      scale: 0.9,
    });
  });
  return out;
}

function fxFromEvents(events: GameEvent[], w: World2): FxSpawn[] {
  const out: FxSpawn[] = [];
  const z = (x: number, y: number): number => (w.map.groundZ(x, y, w.player.z + 2) ?? w.player.z) + 0.05;
  for (const e of events) {
    switch (e.type) {
      case 'shot': {
        if (e.weapon === 'fists') break;
        const h = w.player.heading;
        const x = e.pos.x + Math.cos(h) * 0.25;
        const y = e.pos.y + Math.sin(h) * 0.25;
        out.push({ kind: 'muzzle', x, y, z: w.player.z + 0.5 });
        break;
      }
      case 'hit': {
        const kind = e.surface === 'ped' ? 'bloodspray' : e.surface === 'car' ? 'spark' : 'dust';
        out.push({ kind, x: e.pos.x, y: e.pos.y, z: z(e.pos.x, e.pos.y) + 0.3 });
        break;
      }
      case 'ped_killed':
        out.push({ kind: 'blood', x: e.pos.x, y: e.pos.y, z: z(e.pos.x, e.pos.y) });
        out.push({ kind: 'bloodspray', x: e.pos.x, y: e.pos.y, z: z(e.pos.x, e.pos.y) + 0.2 });
        break;
      case 'car_fire':
        for (let i = 0; i < 3; i++) {
          out.push({ kind: 'fire', x: e.pos.x, y: e.pos.y, z: z(e.pos.x, e.pos.y) + 0.25 });
        }
        break;
      case 'car_crash':
        if (e.speed > 2.2) out.push({ kind: 'smoke', x: e.pos.x, y: e.pos.y, z: z(e.pos.x, e.pos.y) + 0.2 });
        break;
      case 'explosion':
        out.push({ kind: 'explosion', x: e.pos.x, y: e.pos.y, z: z(e.pos.x, e.pos.y) + 0.2 });
        break;
    }
  }
  return out;
}

function tick(now: number): void {
  rafId = requestAnimationFrame(tick);
  if (!world || !renderer) return;
  const dt = Math.min(MAX_FRAME, (now - lastT) / 1000);
  lastT = now;

  if (!paused) {
    const pin = readInput();
    accumulator += dt;
    let first = true;
    while (accumulator >= FIXED_DT) {
      world.update(FIXED_DT, first ? pin : { ...pin, enterExit: false, nextWeapon: false, prevWeapon: false, jump: false });
      accumulator -= FIXED_DT;
      if (first) {
        pending.enterExit = false;
        pending.nextWeapon = false;
        pending.prevWeapon = false;
        pending.jump = false;
      }
      first = false;
    }

    const events = world.drainEvents();
    for (const fx of fxFromEvents(events, world)) renderer.spawnFx(fx);
    audio.handleEvents(
      events.map((e) => {
        const scaled = { ...e, pos: { x: e.pos.x * PX, y: e.pos.y * PX } };
        if (scaled.type === 'car_crash') scaled.speed = e.type === 'car_crash' ? e.speed * PX : 0;
        return scaled;
      }),
      { x: world.player.pos.x * PX, y: world.player.pos.y * PX },
    );
    for (const e of events) {
      if (e.type === 'player_died') {
        showMsg('WASTED', 3);
        respawnTimer = 3;
      }
    }
    if (world.player.dead) {
      respawnTimer -= dt;
      if (respawnTimer <= 0) respawnPlayer();
    }

    // Burning cars: continuous flames + smoke until they cook off.
    for (const c of world.cars) {
      if (!c.onFire || c.exploded) continue;
      if (Math.random() < 0.55) {
        renderer.spawnFx({
          kind: 'fire',
          x: c.pos.x + (Math.random() - 0.5) * c.length * 0.5,
          y: c.pos.y + (Math.random() - 0.5) * c.width * 0.5,
          z: c.z + 0.15,
        });
      }
      if (Math.random() < 0.2) {
        renderer.spawnFx({ kind: 'smoke', x: c.pos.x, y: c.pos.y, z: c.z + 0.25 });
      }
    }

    const car = world.player.car;
    audio.setEngine(!!car && !world.player.dead, car ? Math.min(1, car.speed() / car.handling.maxSpeed) : 0);
    audio.update(dt);
    updateHud(world);

    // GTA2-style district name on entering a new navigation zone. The map
    // stores internal codes (m01, B24...) for some zones — only show names
    // that read like words (the real display strings live in e.gxt).
    const area = world.map.areaName(world.player.pos.x, world.player.pos.y);
    if (area && area !== lastArea) {
      lastArea = area;
      if (!/\d/.test(area) && area.length > 3) showMsg(area.toUpperCase(), 2.5);
    }
  } else {
    audio.setEngine(false, 0);
  }

  if (msgTimer > 0) {
    msgTimer -= dt;
    if (msgTimer <= 0) msgEl.style.opacity = '0';
  }

  renderer.syncEntities(entities(world));
  renderer.syncTracers(world.bullets.map((b) => ({
    id: b.id, x: b.pos.x, y: b.pos.y, z: b.z, angle: b.angle,
  })));
  const p = world.player;
  renderer.update(dt, {
    x: p.pos.x, y: p.pos.y, z: p.z,
    speed: p.car ? p.car.speed() : 0,
    driving: !!p.car,
    vx: p.car?.vel.x ?? 0,
    vy: p.car?.vel.y ?? 0,
  });
  input.endFrame();
}

function respawnPlayer(): void {
  if (!world) return;
  const p = world.player;
  const spawn = world.spawnPoint;
  p.pos = { x: spawn.x, y: spawn.y };
  p.z = spawn.z;
  p.heading = -Math.PI / 2; // face the church entrance
  p.health = 100;
  p.dead = false;
  p.car = null;
  p.inventory.ammo.clear();
  p.inventory.ammo.set('fists', Infinity);
  p.inventory.current = 'fists';
}

btnStart.addEventListener('click', closeMenuAndPlay);
btnControls.addEventListener('click', () => {
  audio.uiClick();
  controlsPanel.classList.toggle('visible');
});
btnSound.addEventListener('click', () => {
  audio.init();
  audio.setEnabled(!audio.enabled);
  btnSound.textContent = audio.enabled ? 'SOUND: ON' : 'SOUND: OFF';
  audio.uiClick();
});
input.onEscape = () => {
  if (!paused) openMenu();
};

void rafId;
openMenu();

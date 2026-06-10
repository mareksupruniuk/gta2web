import { AudioManager } from './audio/audio';
import { Input } from './core/input';
import { Renderer } from './render/renderer';
import { PlayerInput } from './sim/player';
import { World } from './sim/world';
import { WEAPONS } from './sim/weapons';

const FIXED_DT = 1 / 60;
const MAX_FRAME = 0.1;

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

let world: World | null = null;
let renderer: Renderer | null = null;
let paused = true;
let accumulator = 0;
let respawnTimer = 0;
let msgTimer = 0;

function showMsg(text: string, seconds = 2.5): void {
  msgEl.textContent = text;
  msgEl.style.opacity = '1';
  msgTimer = seconds;
}

function updateHud(w: World): void {
  $('hud-health').textContent = String(Math.max(0, Math.ceil(w.player.health)));
  const def = WEAPONS[w.player.inventory.current];
  $('hud-weapon').textContent = w.player.car ? w.player.car.type.id.toUpperCase() : def.name;
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
  audio.init();
  audio.uiClick();
  menuEl.classList.add('hidden');
  hudEl.classList.add('visible');
  paused = false;
  if (!world) void startGame();
}

async function startGame(): Promise<void> {
  world = new World();
  (window as unknown as { __world: World }).__world = world; // debug/test hook
  renderer = await Renderer.create(world, $('game'));
  renderer.app.ticker.add((ticker) => frame(ticker.deltaMS / 1000, ticker));
  showMsg('Steal a car with ENTER. Stay alive.', 4);
}

// Edge-triggered actions are latched here until a sim step consumes them —
// frames shorter than FIXED_DT run zero sim steps and must not eat presses.
const pending = { enterExit: false, nextWeapon: false, prevWeapon: false };

function readInput(): PlayerInput {
  pending.enterExit ||= input.wasPressed('Enter', 'KeyF');
  pending.nextWeapon ||= input.wasPressed('KeyE');
  pending.prevWeapon ||= input.wasPressed('KeyQ');
  return {
    moveX: input.moveX(),
    moveY: input.moveY(),
    attack: input.isDown('Space') || input.wasPressed('Space'),
    enterExit: pending.enterExit,
    nextWeapon: pending.nextWeapon,
    prevWeapon: pending.prevWeapon,
  };
}

function frame(rawDt: number, ticker: import('pixi.js').Ticker): void {
  if (!world || !renderer) return;
  const dt = Math.min(MAX_FRAME, rawDt);

  if (!paused) {
    const pin = readInput();
    accumulator += dt;
    let first = true;
    while (accumulator >= FIXED_DT) {
      // Edge-triggered actions only apply on the first sim step of a frame.
      world.update(FIXED_DT, first ? pin : { ...pin, enterExit: false, nextWeapon: false, prevWeapon: false });
      accumulator -= FIXED_DT;
      if (first) {
        pending.enterExit = false;
        pending.nextWeapon = false;
        pending.prevWeapon = false;
      }
      first = false;
    }

    const events = world.drainEvents();
    renderer.handleEvents(events, world);
    audio.handleEvents(events, world.player.pos);
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

    const car = world.player.car;
    audio.setEngine(!!car && !world.player.dead, car ? Math.min(1, car.speed() / car.type.maxSpeed) : 0);
    audio.update(dt);
    updateHud(world);
  } else {
    audio.setEngine(false, 0);
  }

  if (msgTimer > 0) {
    msgTimer -= dt;
    if (msgTimer <= 0) msgEl.style.opacity = '0';
  }

  renderer.update(dt, world, ticker);
  input.endFrame();
}

function respawnPlayer(): void {
  if (!world) return;
  const p = world.player;
  p.pos = { ...world.map.playerSpawn };
  p.health = 100;
  p.dead = false;
  p.car = null;
  p.inventory.ammo.clear();
  p.inventory.ammo.set('fists', Infinity);
  p.inventory.current = 'fists';
}

// ----------------------------------------------------------------- menu UI

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

openMenu();

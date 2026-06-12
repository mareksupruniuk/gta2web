import { AudioManager } from './audio/audio';
import { Gta2Bank } from './audio/gta2bank';
import { Input } from './core/input';
import { setModelPhysics } from './game2/car2';
import { CityMap } from './game2/citymap';
import { GangMember } from './game2/gangs';
import { Cop } from './game2/police';
import { Pickup, PlayerInput, World2 } from './game2/world2';
import { parseGci } from './gta2/gci';
import { parseGmp } from './gta2/gmp';
import { parseSty, Sty } from './gta2/sty';
import { CityRenderer, FxSpawn, RenderEntity, TracerKind } from './render3d/renderer3d';
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
let lastWanted = 0;
let rafId = 0;
let lastT = 0;
/** attack key held this frame — drives punch/firing stances */
let playerAttacking = false;

// Sprite numbering within the style file (bases are cumulative counts).
let PED_SPRITE_BASE = 0;
let OBJ_SPRITE_BASE = 0;
let MAPOBJ_SPRITE_BASE = 0;
// Original art: GTA2 objective arrow (codeObj 1), phone box (mapObj 58).
const ARROW_CODEOBJ = 1;
const PHONE_MAPOBJ = 58;

// Authentic ped animation table (docs/gta2-reference.md §2, from gta2_re):
// 474 ped sprites = 3 sets of 158. Within a set:
const PED_SET_PLAYER = 0;
const PED_SET_CIVILIAN = 158; // graphic_type 1 is the game's default
const PED_SET_COP = 316; // army/cop set (graphic_type 2)
const ANIM = {
  walk: { base: 0, frames: 8 },
  run: { base: 8, frames: 8 },
  jump: { base: 16, frames: 8 },
  armedWalk: { base: 37, frames: 8 },
  idle: { base: 53, frames: 4 },
  punchStand: { base: 115, frames: 8 },
  punchMove: { base: 123, frames: 8 },
  firing: 139,
  corpses: [156, 157],
  burnedCorpse: 155,
};
// Pickup art: 8 rotation frames per weapon starting at these obj-sprite bases.
const PICKUP_SPRITES: Record<Pickup['kind'], number> = {
  pistol: 18,
  dual_pistol: 18,
  s_uzi: 26,
  rocket: 34,
  silenced_s_uzi: 42,
  molotov: 50,
  grenade: 58,
  shotgun: 66,
  electrogun: 74,
  flamethrower: 82,
  uzi: 90,
  health: 10,
};
const PICKUP_FRAMES = 8;

const hudRightEl = $('hud-right');
const zoneEl = $('zone');
const mtextEl = $('mtext');
const arrowEl = $('arrow');
let zoneTimer = 0;
let mtextTimer = 0;

function showMissionText(text: string, seconds = 9): void {
  mtextEl.textContent = text;
  mtextEl.style.opacity = '1';
  mtextTimer = seconds;
}

function showZone(name: string): void {
  zoneEl.textContent = name;
  zoneEl.style.opacity = '1';
  zoneTimer = 3;
}

function showMsg(text: string, seconds = 2.5): void {
  msgEl.textContent = text;
  msgEl.style.opacity = '1';
  msgTimer = seconds;
}

function updateHud(w: World2): void {
  // GTA2 health: a row of red hearts, one per 20 HP.
  $('hud-health').textContent = '\u2665'.repeat(Math.max(0, Math.ceil(w.player.health / 20)));
  $('hud-weapon').textContent = w.player.car ? 'DRIVING' : w.player.inventory.currentDef().name;
  const ammo = w.player.inventory.currentAmmo();
  $('hud-ammo').textContent = !w.player.car && Number.isFinite(ammo) ? `× ${ammo}` : '';
  $('hud-score').textContent = String(w.player.score);
  // gang attitudes (respect): name + stance, GTA2-style
  const gangsEl = $('gangs');
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const t of w.turfs) {
    if (seen.has(t.gang.id)) continue;
    seen.add(t.gang.id);
    const r = w.gangRespect.get(t.gang.id) ?? 0;
    const stance = r <= -20 ? 'HOSTILE' : r < 0 ? 'WARY' : r < 30 ? 'NEUTRAL' : 'ALLIED';
    const cls = stance.toLowerCase();
    rows.push(`<div class="gang"><span class="gname g-${t.gang.id}">${t.gang.name.toUpperCase()}</span> <span class="stance ${cls}">${stance}</span></div>`);
  }
  if (gangsEl.dataset.html !== rows.join('')) {
    gangsEl.dataset.html = rows.join('');
    gangsEl.innerHTML = rows.join('');
  }

  const wantedEl = $('wanted');
  const lvl = w.wanted.level;
  wantedEl.classList.toggle('visible', lvl > 0);
  if (lvl !== lastWanted) {
    wantedEl.textContent = '👮'.repeat(lvl);
    if (lvl > lastWanted) {
      wantedEl.classList.remove('flash');
      void wantedEl.offsetWidth; // restart the CSS animation
      wantedEl.classList.add('flash');
    }
    lastWanted = lvl;
  }
}

function openMenu(): void {
  paused = true;
  menuEl.classList.remove('hidden');
  hudEl.classList.remove('visible');
  hudRightEl.classList.remove('visible');
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
  hudRightEl.classList.add('visible');
  paused = false;
}

async function startGame(): Promise<void> {
  starting = true;
  btnStart.textContent = 'LOADING…';
  try {
    // ?map=ste / ?map=bil loads the other districts (default: Downtown).
    const district = new URLSearchParams(location.search).get('map') ?? 'wil';
    const [gmpBuf, styBuf, gciText] = await Promise.all([
      fetch(`gamedata/${district}.gmp`).then((r) => {
        if (!r.ok) throw new Error(`${district}.gmp missing — put GTA2 data files in gamedata/`);
        return r.arrayBuffer();
      }),
      fetch(`gamedata/${district}.sty`).then((r) => {
        if (!r.ok) throw new Error(`${district}.sty missing — put GTA2 data files in gamedata/`);
        return r.arrayBuffer();
      }),
      // Original per-model handling table; optional (tier fallback without it).
      fetch('gamedata/nyc.gci').then((r) => (r.ok ? r.text() : null)).catch(() => null),
    ]);
    sty = parseSty(styBuf);
    setModelPhysics(gciText ? parseGci(gciText) : null);
    PED_SPRITE_BASE = sty.spriteBase.car;
    OBJ_SPRITE_BASE = sty.spriteBase.car + sty.spriteBase.ped;
    MAPOBJ_SPRITE_BASE = OBJ_SPRITE_BASE + sty.spriteBase.codeObj;
    const map = new CityMap(parseGmp(gmpBuf));
    // Spawn outside the Jesus Saves church in Avalon (north-west Downtown).
    world = new World2(map, sty, 1999, district === 'wil' ? { x: 9.5, y: 14.5 } : undefined);
    (window as unknown as { __world: World2 }).__world = world; // debug/test hook
    renderer = CityRenderer.create($('game'), map.gmp, sty);
    (window as unknown as { __renderer: CityRenderer }).__renderer = renderer;

    // Original GTA2 sound bank for this district (async; synth/CC0 until loaded).
    const actx = audio.audioContext;
    if (actx) {
      void Gta2Bank.load(actx, district).then((bank) => {
        if (bank) audio.attachBank(bank);
      });
    }

    menuEl.classList.add('hidden');
    hudEl.classList.add('visible');
    hudRightEl.classList.add('visible');
    paused = false;
    lastT = performance.now();
    rafId = requestAnimationFrame(tick);
    showMsg(`Welcome to ${DISTRICT_NAMES[district] ?? district}. ENTER steals a car.`, 4);
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
    // Visible damage: deltas 0-3 are the four corner dents, 4 the smashed
    // windscreen (docs/gta2-reference.md §6) — pile them on as health drops.
    const dents = car.exploded ? 0 : car.health < 15 ? 5 : car.health < 30 ? 4 : car.health < 45 ? 3 : car.health < 60 ? 2 : car.health < 75 ? 1 : 0;
    const deltas = dents > 0 ? Array.from({ length: dents }, (_, i) => i) : [];
    // police roof lights: alternate the two flash deltas while heat is on
    // (cop car deltas 15/16 = left/right strobes, verified by pixel diff)
    if (!car.exploded && w.isCopCar(car.id) && w.wanted.level > 0) {
      const nDeltas = s.deltas.get(car.info.spriteIdx)?.length ?? 0;
      if (nDeltas > 16) deltas.push(Math.floor(w.time * 6) % 2 === 0 ? 15 : 16);
    }
    out.push({
      key: `car:${car.id}`,
      sprite: car.info.spriteIdx,
      remapPhys: car.remap >= 0 ? s.carRemapPalette(car.remap) : undefined,
      tint: car.exploded ? 0x3a3a3a : undefined,
      deltas: deltas.length > 0 ? deltas : undefined,
      x: car.pos.x, y: car.pos.y, z: car.z + 0.05,
      angle: car.heading,
      shadow: !car.exploded,
      ...gradAt(w, car.pos.x, car.pos.y, car.z),
    });
  }
  for (const ped of w.peds) {
    const isCop = ped.isCop;
    const set = isCop ? PED_SET_COP : PED_SET_CIVILIAN;
    let frame: number;
    if (ped.dead) {
      frame = ped.burned ? ANIM.burnedCorpse : ANIM.corpses[ped.id % ANIM.corpses.length];
    } else if ((ped instanceof Cop || ped instanceof GangMember) && ped.shooting) {
      frame = ANIM.firing;
    } else if (ped.state === 'flee' || isCop) {
      frame = ANIM.run.base + (Math.floor(ped.animTime * 12) % ANIM.run.frames);
    } else if (ped instanceof GangMember) {
      // members patrol with their piece out
      frame = ANIM.armedWalk.base + (Math.floor(ped.animTime * 10) % ANIM.armedWalk.frames);
    } else {
      frame = ANIM.walk.base + (Math.floor(ped.animTime * 10) % ANIM.walk.frames);
    }
    out.push({
      key: `ped:${ped.id}`,
      sprite: PED_SPRITE_BASE + set + frame,
      remapPhys: ped.remap >= 0 ? s.pedRemapPalette(ped.remap) : undefined,
      x: ped.pos.x, y: ped.pos.y, z: ped.z + (ped.dead ? 0.02 : 0.03),
      angle: ped.heading,
      shadow: !ped.dead,
      ...(ped.dead ? {} : gradAt(w, ped.pos.x, ped.pos.y, ped.z)),
    });
  }
  const p = w.player;
  if (!p.car && !p.dead) {
    const armed = p.inventory.current !== 'fists';
    let frame: number;
    if (p.vz !== 0) {
      // airborne: jump cycle paced over the hop
      frame = ANIM.jump.base + Math.min(ANIM.jump.frames - 1, Math.floor((1 - Math.max(0, p.vz) / 4.3) * ANIM.jump.frames));
    } else if (playerAttacking && !armed) {
      frame = (p.moving ? ANIM.punchMove : ANIM.punchStand).base + (Math.floor(p.animTime * 14) % 8);
    } else if (playerAttacking && armed) {
      frame = ANIM.firing;
    } else if (p.moving) {
      const cycle = armed ? ANIM.armedWalk : ANIM.walk;
      frame = cycle.base + (Math.floor(p.animTime * 10) % cycle.frames);
    } else {
      frame = ANIM.idle.base + (Math.floor(w.time * 3) % ANIM.idle.frames);
    }
    out.push({
      key: 'player',
      sprite: PED_SPRITE_BASE + PED_SET_PLAYER + frame,
      x: p.pos.x, y: p.pos.y, z: p.z + 0.035,
      angle: p.heading,
      shadow: true,
      ...gradAt(w, p.pos.x, p.pos.y, p.z),
    });
  }
  // phone boxes: the original map-object sprite, always visible
  w.missions.phones.forEach((ph, i) => {
    out.push({
      key: `phonebox:${i}`,
      sprite: MAPOBJ_SPRITE_BASE + PHONE_MAPOBJ,
      x: ph.pos.x, y: ph.pos.y, z: ph.z + 0.04,
      angle: 0,
      scale: 1.15,
    });
  });
  w.pickups.forEach((pk, i) => {
    if (pk.respawnIn > 0) return;
    // health is a single sprite; weapons have 8 rotation frames of art
    const frame = pk.kind === 'health' ? 0 : Math.floor(w.time * 9 + i) % PICKUP_FRAMES;
    out.push({
      key: `pickup:${i}`,
      sprite: OBJ_SPRITE_BASE + PICKUP_SPRITES[pk.kind] + frame,
      x: pk.pos.x, y: pk.pos.y, z: pk.z + 0.04,
      angle: 0,
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
      case 'molotov_smash':
        for (let i = 0; i < 5; i++) {
          out.push({
            kind: 'fire',
            x: e.pos.x + (Math.random() - 0.5) * 0.6,
            y: e.pos.y + (Math.random() - 0.5) * 0.6,
            z: z(e.pos.x, e.pos.y) + 0.1,
          });
        }
        break;
      case 'ped_on_fire':
        out.push({ kind: 'fire', x: e.pos.x, y: e.pos.y, z: z(e.pos.x, e.pos.y) + 0.2 });
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
    playerAttacking = pin.attack;
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
    for (const e of events) {
      if (e.type === 'score') {
        const z = world.map.groundZ(e.pos.x, e.pos.y, world.player.z + 2) ?? world.player.z;
        renderer.spawnScore(e.pos.x, e.pos.y, z, e.amount);
        if (e.label) showMsg(e.label, 2);
      }
    }
    // Tire marks: two streaks at the rear wheels while sliding.
    for (const c of world.cars) {
      if (!c.skidding || c.exploded) continue;
      const cos = Math.cos(c.heading);
      const sin = Math.sin(c.heading);
      const bx = c.pos.x - cos * c.length * 0.32;
      const by = c.pos.y - sin * c.length * 0.32;
      const wx = -sin * c.width * 0.38;
      const wy = cos * c.width * 0.38;
      renderer.addSkidMark(bx + wx, by + wy, c.z, c.heading);
      renderer.addSkidMark(bx - wx, by - wy, c.z, c.heading);
    }
    // Battered (not yet burning) cars trail grey engine smoke.
    for (const c of world.cars) {
      if (c.exploded || c.onFire || c.health >= 45 || Math.random() > 0.16) continue;
      const cos = Math.cos(c.heading);
      const sin = Math.sin(c.heading);
      renderer.spawnFx({
        kind: 'smoke',
        x: c.pos.x + cos * c.length * 0.3,
        y: c.pos.y + sin * c.length * 0.3,
        z: c.z + 0.18,
      });
    }
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
        audio.playVocal('wasted', { priority: true });
        respawnTimer = 3;
      } else if (e.type === 'busted') {
        showMsg('BUSTED', 3);
        audio.playVocal('busted', { priority: true });
      } else if (e.type === 'mission_start') {
        showMissionText(e.text);
      } else if (e.type === 'mission_complete') {
        showMsg('JOB COMPLETE!', 3);
        audio.playVocal('jobcomplete', { priority: true });
        mtextEl.style.opacity = '0';
      } else if (e.type === 'mission_failed') {
        showMsg('JOB FAILED', 3);
        audio.playVocal('jobfail', { priority: true });
        mtextEl.style.opacity = '0';
      } else if (e.type === 'phone_ring') {
        audio.playPhoneRing();
      } else if (e.type === 'car_enter' && e.jacked) {
        audio.playVocal(Math.random() < 0.5 ? 'carjacker' : 'gta');
      } else if (e.type === 'pickup' && e.kind) {
        const v = PICKUP_VOCALS[e.kind];
        if (v) audio.playVocal(v);
      } else if (e.type === 'score') {
        // announcer taunts: always for cop kills, occasionally otherwise
        if (e.amount === 150) audio.playVocal('copkilla');
        else if (e.label === 'COP CAR CRUSH!') audio.playVocal('hallelujah');
        else if (e.amount === 50 && Math.random() < 0.12) {
          audio.playVocal(KILL_TAUNTS[Math.floor(Math.random() * KILL_TAUNTS.length)]);
        }
      }
    }
    if (world.player.dead) {
      respawnTimer -= dt;
      if (respawnTimer <= 0) respawnPlayer();
    }

    // Burning cars: continuous flames + smoke until they cook off.
    let fireNear = 0;
    for (const c of world.cars) {
      if (!c.onFire || c.exploded) continue;
      fireNear = Math.max(fireNear, 1 - Math.hypot(c.pos.x - world.player.pos.x, c.pos.y - world.player.pos.y) / 8);
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
    // Fire pools (molotovs) and burning peds.
    for (const pool of world.firePools) {
      fireNear = Math.max(fireNear, 1 - Math.hypot(pool.pos.x - world.player.pos.x, pool.pos.y - world.player.pos.y) / 8);
      if (Math.random() < 0.7) {
        renderer.spawnFx({
          kind: 'fire',
          x: pool.pos.x + (Math.random() - 0.5) * 1.1,
          y: pool.pos.y + (Math.random() - 0.5) * 1.1,
          z: pool.z + 0.06,
        });
      }
      if (Math.random() < 0.12) {
        renderer.spawnFx({ kind: 'smoke', x: pool.pos.x, y: pool.pos.y, z: pool.z + 0.2 });
      }
    }
    for (const ped of world.peds) {
      if (!ped.onFire || ped.dead) continue;
      if (Math.random() < 0.7) {
        renderer.spawnFx({ kind: 'fire', x: ped.pos.x, y: ped.pos.y, z: ped.z + 0.12 });
      }
    }
    // Rocket exhaust trail.
    for (const b of world.bullets) {
      if (b.isRocket && Math.random() < 0.6) {
        renderer.spawnFx({ kind: 'smoke', x: b.pos.x, y: b.pos.y, z: b.z });
      }
    }
    // ElectroGun beam.
    if (world.beam) {
      renderer.drawBeam(world.beam.x0, world.beam.y0, world.beam.x1, world.beam.y1, world.beam.z);
    }

    // Continuous audio layers.
    const def = world.player.inventory.currentDef();
    const firing = !world.player.dead && !world.player.car;
    audio.setFlamethrower(firing && def.id === 'flamethrower' && world.flames.length > 0);
    audio.setElectro(firing && !!world.beam);
    audio.setFireNearby(Math.max(0, Math.min(1, fireNear)));
    // Siren wail follows the nearest active pursuit car.
    let sirenNear = 0;
    for (const p of world.pursuits) {
      if (p.car.exploded) continue;
      const d = Math.hypot(p.car.pos.x - world.player.pos.x, p.car.pos.y - world.player.pos.y);
      sirenNear = Math.max(sirenNear, 1 - d / 14);
    }
    audio.setSiren(sirenNear);

    const car = world.player.car;
    audio.setEngine(!!car && !world.player.dead, car ? Math.min(1, car.speed() / car.handling.maxSpeed) : 0);
    // Bank engine sample by vehicle class (docs §1: 3 default, 4 small,
    // 5 sports, 6 sedans, 7 vans, 8 trucks/bus) — approximated by size/rating.
    if (car) {
      const h = car.info.h;
      const cls = h <= 56 ? 4 : car.info.rating >= 21 && h < 70 ? 5 : h <= 66 ? 6 : h <= 80 ? 7 : 8;
      audio.setEngineClass(cls);
    } else {
      audio.setEngineClass(null);
    }
    // Footsteps while walking on foot; light crowd chatter near civilians.
    if (!car && !world.player.dead && world.player.moving && world.player.vz === 0) {
      audio.playFootstep(false);
    }
    let crowd = 0;
    for (const ped of world.peds) {
      if (ped.dead) continue;
      const d = Math.hypot(ped.pos.x - world.player.pos.x, ped.pos.y - world.player.pos.y);
      if (d < 5) crowd += 1 - d / 5;
    }
    audio.setCrowd(Math.min(1, crowd / 4));
    // distant traffic hum follows how many cars are driving around the player
    let movingNear = 0;
    for (const c of world.cars) {
      if (c.exploded || c.speed() < 0.5) continue;
      if (Math.hypot(c.pos.x - world.player.pos.x, c.pos.y - world.player.pos.y) < 14) movingNear++;
    }
    audio.setTraffic(Math.min(1, movingNear / 5));
    audio.update(dt);
    updateHud(world);

    // GTA2-style district name on entering a new navigation zone. The map
    // stores internal codes (m01, B24...) for some zones — only show names
    // that read like words (the real display strings live in e.gxt).
    const area = world.map.areaName(world.player.pos.x, world.player.pos.y);
    if (area && area !== lastArea) {
      lastArea = area;
      if (!/\d/.test(area) && area.length > 3) showZone(area.toUpperCase());
    }
  } else {
    audio.setEngine(false, 0);
    audio.setFlamethrower(false);
    audio.setElectro(false);
    audio.setFireNearby(0);
    audio.setSiren(0);
  }
  audio.setAmbience(!paused);

  if (msgTimer > 0) {
    msgTimer -= dt;
    if (msgTimer <= 0) msgEl.style.opacity = '0';
  }
  if (zoneTimer > 0) {
    zoneTimer -= dt;
    if (zoneTimer <= 0) zoneEl.style.opacity = '0';
  }
  if (mtextTimer > 0) {
    mtextTimer -= dt;
    if (mtextTimer <= 0) mtextEl.style.opacity = '0';
  }

  renderer.syncTracers([
    ...world.bullets.map((b) => ({
      id: b.id, kind: (b.isRocket ? 'rocket' : 'bullet') as TracerKind,
      x: b.pos.x, y: b.pos.y, z: b.z, angle: b.angle,
    })),
    ...world.thrown.map((t) => ({
      id: t.id, kind: t.kind as TracerKind,
      x: t.pos.x, y: t.pos.y, z: t.z, angle: world!.time * 7, // tumbling
    })),
    ...world.flames.map((f) => ({
      id: f.id, kind: 'flame' as TracerKind,
      x: f.pos.x, y: f.pos.y, z: f.z, angle: 0, age: f.age,
    })),
  ]);
  // mission markers: idle phones ring cyan, the active objective is yellow
  const markers: { key: string; x: number; y: number; z: number; kind: 'phone' | 'objective' }[] = [];
  world.missions.phones.forEach((ph, i) => {
    if (!world!.missions.active && ph.cooldown === 0) {
      markers.push({ key: `phone:${i}`, x: ph.pos.x, y: ph.pos.y, z: ph.z, kind: 'phone' });
    }
  });
  const mission = world.missions.active;
  if (mission) {
    const tz = world.map.groundZ(mission.target.x, mission.target.y, world.player.z + 2) ?? world.player.z;
    markers.push({ key: 'objective', x: mission.target.x, y: mission.target.y, z: tz, kind: 'objective' });
  }
  renderer.syncMarkers(markers);
  // The original GTA2 arrow sprite floats beside the player, bobbing along
  // its direction: yellow to the objective, cyan to the nearest phone.
  arrowEl.style.display = 'none'; // DOM fallback retired
  {
    let arrowTarget: { x: number; y: number; tint: number } | null = null;
    if (mission) {
      arrowTarget = { x: mission.target.x, y: mission.target.y, tint: 0xffd700 };
    } else {
      let best: { x: number; y: number } | null = null;
      let bestD = Infinity;
      for (const ph of world.missions.phones) {
        if (ph.cooldown > 0) continue;
        const d = Math.hypot(ph.pos.x - world.player.pos.x, ph.pos.y - world.player.pos.y);
        if (d < bestD) { bestD = d; best = ph.pos; }
      }
      if (best && bestD > 1.5) arrowTarget = { ...best, tint: 0x66e0ff };
    }
    if (arrowTarget && !paused && !world.player.dead) {
      const am = Math.atan2(arrowTarget.y - world.player.pos.y, arrowTarget.x - world.player.pos.x);
      const bob = 0.18 + Math.sin(world.time * 5) * 0.14; // GTA2 bounce
      const dist0 = 1.0 + bob;
      renderer.syncEntities([
        ...entities(world),
        {
          key: 'objective-arrow',
          sprite: OBJ_SPRITE_BASE + ARROW_CODEOBJ,
          x: world.player.pos.x + Math.cos(am) * dist0,
          y: world.player.pos.y + Math.sin(am) * dist0,
          z: world.player.z + 1.1,
          angle: am,
          tint: arrowTarget.tint,
          scale: 1.25,
        },
      ]);
    } else {
      renderer.syncEntities(entities(world));
    }
  }

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

// Original announcer vocals for weapon/health pickups (Vocals/*.wav).
const PICKUP_VOCALS: Record<string, string> = {
  pistol: 'pistolp', dual_pistol: 'dualpist', uzi: 'macgun', s_uzi: 'macgun',
  silenced_s_uzi: 'silentmg', shotgun: 'shotgun', rocket: 'rocketl',
  electrogun: 'electrofingers', flamethrower: 'flamet', molotov: 'molotovs',
  grenade: 'grenades', health: 'health',
};
const KILL_TAUNTS = [
  'sorryaboutthat', 'thatsgottahurt', 'oohdidthathurt', 'sorrydidthathurt',
  'laugh1', 'laugh3', 'laugh7',
];

const DISTRICT_NAMES: Record<string, string> = {
  wil: 'Downtown',
  ste: 'the Residential District',
  bil: 'the Industrial District',
};

// District selection: highlight from the URL; clicking navigates so the
// whole pipeline (map, style, sounds, spawn) reloads for the new district.
const currentDistrict = new URLSearchParams(location.search).get('map') ?? 'wil';
$('menu-subtitle').textContent =
  currentDistrict === 'ste' ? 'RESIDENTIAL DISTRICT' : currentDistrict === 'bil' ? 'INDUSTRIAL DISTRICT' : 'DOWNTOWN DISTRICT';
for (const btn of document.querySelectorAll<HTMLButtonElement>('#districts button')) {
  btn.classList.toggle('active', btn.dataset.map === currentDistrict);
  btn.addEventListener('click', () => {
    if (btn.dataset.map === currentDistrict) return;
    const url = new URL(location.href);
    if (btn.dataset.map === 'wil') url.searchParams.delete('map');
    else url.searchParams.set('map', btn.dataset.map!);
    location.href = url.toString();
  });
}

// Day / dusk / dawn colour grading, persisted across sessions.
const TIMES = ['day', 'dusk', 'dawn'] as const;
const daylightEl = $('daylight');
const btnTime = $<HTMLButtonElement>('btn-time');
let timeMode = (localStorage.getItem('gta2.time') ?? 'dusk') as (typeof TIMES)[number];
function applyTimeMode(): void {
  daylightEl.className = timeMode === 'day' ? '' : timeMode;
  btnTime.textContent = `TIME: ${timeMode.toUpperCase()}`;
}
applyTimeMode();
btnTime.addEventListener('click', () => {
  timeMode = TIMES[(TIMES.indexOf(timeMode) + 1) % TIMES.length];
  localStorage.setItem('gta2.time', timeMode);
  applyTimeMode();
  audio.uiClick();
});

// ---------------------------------------------------------------- screen FX
// CSS-filter colour grading on the world canvas + generated film grain +
// scanlines, controlled from the in-game FX panel (persisted).
interface FxSettings {
  preset: string;
  grain: number; // 0-30 (percent opacity*100)
  scan: boolean;
  sat: number; // percent
  con: number;
  bri: number;
}
const FX_PRESETS: Record<string, string> = {
  none: '',
  cinematic: 'saturate(1.12) contrast(1.06)',
  vivid: 'saturate(1.5) contrast(1.1)',
  sepia: 'sepia(0.8) contrast(1.05) brightness(1.02)',
  grayscale: 'grayscale(1) contrast(1.08)',
  noir: 'grayscale(1) contrast(1.4) brightness(0.92)',
  retro: 'sepia(0.25) saturate(1.2) contrast(1.12)',
};
const FX_DEFAULT: FxSettings = { preset: 'cinematic', grain: 8, scan: false, sat: 100, con: 100, bri: 100 };
let fx: FxSettings = { ...FX_DEFAULT };
try {
  fx = { ...FX_DEFAULT, ...JSON.parse(localStorage.getItem('gta2.fx') ?? '{}') };
} catch { /* defaults */ }

const gameEl = $('game');
const grainEl = $('grain');
const scanEl = $('scanlines');

// one-time generated noise tile for the grain overlay
{
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 160;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(160, 160);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 90 + Math.random() * 130;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  grainEl.style.backgroundImage = `url(${c.toDataURL()})`;
}
// animate the grain by jumping the tile around at ~12fps
setInterval(() => {
  if (fx.grain > 0) {
    grainEl.style.backgroundPosition = `${Math.floor(Math.random() * 160)}px ${Math.floor(Math.random() * 160)}px`;
  }
}, 80);

function applyFx(): void {
  const parts = [FX_PRESETS[fx.preset] ?? ''];
  if (fx.sat !== 100) parts.push(`saturate(${fx.sat / 100})`);
  if (fx.con !== 100) parts.push(`contrast(${fx.con / 100})`);
  if (fx.bri !== 100) parts.push(`brightness(${fx.bri / 100})`);
  gameEl.style.filter = parts.join(' ').trim();
  grainEl.style.opacity = String(fx.grain / 100);
  scanEl.classList.toggle('on', fx.scan);
  localStorage.setItem('gta2.fx', JSON.stringify(fx));
}

const fxPreset = $<HTMLSelectElement>('fx-preset');
const fxGrain = $<HTMLInputElement>('fx-grain');
const fxScan = $<HTMLInputElement>('fx-scan');
const fxSat = $<HTMLInputElement>('fx-sat');
const fxCon = $<HTMLInputElement>('fx-con');
const fxBri = $<HTMLInputElement>('fx-bri');
function syncFxPanel(): void {
  fxPreset.value = fx.preset;
  fxGrain.value = String(fx.grain);
  fxScan.checked = fx.scan;
  fxSat.value = String(fx.sat);
  fxCon.value = String(fx.con);
  fxBri.value = String(fx.bri);
}
syncFxPanel();
applyFx();
$('fx-tab').addEventListener('click', () => $('fx-panel').classList.toggle('open'));
fxPreset.addEventListener('change', () => { fx.preset = fxPreset.value; applyFx(); });
fxGrain.addEventListener('input', () => { fx.grain = +fxGrain.value; applyFx(); });
fxScan.addEventListener('change', () => { fx.scan = fxScan.checked; applyFx(); });
fxSat.addEventListener('input', () => { fx.sat = +fxSat.value; applyFx(); });
fxCon.addEventListener('input', () => { fx.con = +fxCon.value; applyFx(); });
fxBri.addEventListener('input', () => { fx.bri = +fxBri.value; applyFx(); });
$('fx-reset').addEventListener('click', () => {
  fx = { ...FX_DEFAULT };
  syncFxPanel();
  applyFx();
});

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

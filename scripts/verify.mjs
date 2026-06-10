// Smoke-test the game in headless Chromium: load real GTA2 Downtown, start,
// walk, steal a car, drive, shoot, pause/resume. Fails on any page error.
// Requires the dev server: npm run dev -- --port 5179
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const URL = process.env.GAME_URL ?? 'http://localhost:5179/';
mkdirSync('.verify', { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

await page.goto(URL, { waitUntil: 'networkidle' });
await page.screenshot({ path: '.verify/1-menu.png' });

await page.click('#btn-start');
await page.waitForFunction(() => !!window.__world && !!document.querySelector('#game canvas'), null, { timeout: 40000 });
await page.waitForTimeout(2000);
await page.screenshot({ path: '.verify/2-onfoot.png' });

// Rotation controls: walk forward, then rotate.
const pos0 = await page.evaluate(() => ({ ...window.__world.player.pos }));
await page.keyboard.down('KeyW');
await page.waitForTimeout(900);
await page.keyboard.up('KeyW');
const pos1 = await page.evaluate(() => ({ ...window.__world.player.pos }));
if (Math.hypot(pos1.x - pos0.x, pos1.y - pos0.y) < 0.3) fail('player did not walk');

// Steal the parked car (teleport next to it for determinism).
await page.evaluate(() => {
  const w = window.__world;
  const parked = w.cars.filter((c) => !c.driver && !c.exploded)
    .sort((a, b) => Math.hypot(a.pos.x - w.player.pos.x, a.pos.y - w.player.pos.y) - Math.hypot(b.pos.x - w.player.pos.x, b.pos.y - w.player.pos.y))[0];
  w.player.pos = { x: parked.pos.x + 0.5, y: parked.pos.y };
  w.player.z = parked.z;
});
await page.keyboard.press('Enter');
await page.waitForTimeout(250);
if (!(await page.evaluate(() => !!window.__world.player.car))) fail('did not enter car');

const carPos0 = await page.evaluate(() => ({ ...window.__world.player.car.pos }));
await page.keyboard.down('KeyW');
await page.waitForTimeout(2500);
await page.screenshot({ path: '.verify/3-driving.png' });
await page.keyboard.up('KeyW');
const carPos1 = await page.evaluate(() => ({ ...window.__world.player.car.pos }));
if (Math.hypot(carPos1.x - carPos0.x, carPos1.y - carPos0.y) < 1) fail('car did not drive');

// Exit, grab a pistol via debug hook, fire.
await page.keyboard.press('Enter');
await page.waitForTimeout(250);
if (await page.evaluate(() => !!window.__world.player.car)) fail('did not exit car');
await page.evaluate(() => window.__world.player.inventory.add('pistol', 24));
await page.keyboard.down('Space');
await page.waitForTimeout(60);
await page.keyboard.up('Space');
const ammo = await page.evaluate(() => window.__world.player.inventory.currentAmmo());
if (ammo !== 23) fail(`pistol shot should leave 23 ammo, got ${ammo}`);
await page.screenshot({ path: '.verify/4-onfoot-armed.png' });

// Pause / resume.
await page.keyboard.press('Escape');
const menuVisible = await page.evaluate(() => !document.getElementById('menu').classList.contains('hidden'));
const label = await page.locator('#btn-start').textContent();
await page.click('#btn-start');
const menuHidden = await page.evaluate(() => document.getElementById('menu').classList.contains('hidden'));
if (!menuVisible || label !== 'RESUME' || !menuHidden) fail('pause/resume broken');

const stats = await page.evaluate(() => ({
  peds: window.__world.peds.length,
  cars: window.__world.cars.length,
  movingCars: window.__world.cars.filter((c) => Math.hypot(c.vel.x, c.vel.y) > 0.3).length,
  hud: document.getElementById('hud-weapon').textContent,
}));
console.log('World stats:', JSON.stringify(stats));

await browser.close();
if (errors.length) {
  console.error('ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('OK — no page errors');

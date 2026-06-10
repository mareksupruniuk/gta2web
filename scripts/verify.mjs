// Smoke-test the game in headless Chromium: load, start, walk, enter a car,
// drive, shoot. Fails on any page error. Screenshots land in .verify/.
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

await page.goto(URL, { waitUntil: 'networkidle' });
await page.screenshot({ path: '.verify/1-menu.png' });

await page.click('#btn-start');
// Wait until the game world exists and the canvas is up (cold Vite
// transforms can make init slow), then let the city settle.
await page.waitForFunction(() => !!window.__world && !!document.querySelector('#game canvas'), null, { timeout: 15000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: '.verify/2-onfoot.png' });

// Enter the parked car next to spawn, then drive.
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
const inCar1 = await page.locator('#hud-weapon').textContent();
const carType = await page.evaluate(() => window.__world.player.car?.type.id ?? null);
if (!carType) {
  console.error(`FAIL: expected to be driving, HUD shows "${inCar1}", world says no car`);
  process.exit(1);
}
await page.keyboard.down('KeyW');
await page.waitForTimeout(2200);
await page.keyboard.down('KeyA');
await page.waitForTimeout(700);
await page.keyboard.up('KeyA');
await page.waitForTimeout(800);
await page.keyboard.up('KeyW');
await page.screenshot({ path: '.verify/4-driving.png' });

// Exit, screenshot HUD state.
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await page.screenshot({ path: '.verify/5-exited.png' });

// Grab a pistol via the debug hook and fire.
await page.evaluate(() => window.__world.player.inventory.add('pistol', 24));
await page.keyboard.down('Space');
await page.waitForTimeout(40); // bullets live <0.7s; sample right after firing
const bullets = await page.evaluate(() => window.__world.bullets.length);
await page.keyboard.up('Space');
const ammo = await page.evaluate(() => window.__world.player.inventory.currentAmmo());
if (ammo !== 23) {
  console.error(`FAIL: pistol shot should leave 23 ammo, got ${ammo} (bullets seen: ${bullets})`);
  process.exit(1);
}
console.log(`Pistol fired: ${bullets} bullet(s) in flight, ammo ${ammo}`);
const stats = await page.evaluate(() => ({
  peds: window.__world.peds.length,
  cars: window.__world.cars.length,
}));
console.log('World stats:', JSON.stringify(stats));

const hud = {
  health: await page.locator('#hud-health').textContent(),
  weapon: await page.locator('#hud-weapon').textContent(),
  score: await page.locator('#hud-score').textContent(),
  weaponWhileDriving: inCar1,
};
console.log('HUD:', JSON.stringify(hud));
console.log('Canvas present:', await page.locator('#game canvas').count());

await browser.close();

if (errors.length) {
  console.error('ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('OK — no page errors');

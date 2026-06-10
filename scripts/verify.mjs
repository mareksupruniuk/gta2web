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
await page.waitForTimeout(2500);
await page.screenshot({ path: '.verify/2-onfoot.png' });

// Walk around and punch.
await page.keyboard.down('KeyW');
await page.waitForTimeout(900);
await page.keyboard.up('KeyW');
await page.keyboard.down('KeyD');
await page.waitForTimeout(600);
await page.keyboard.up('KeyD');
await page.keyboard.press('Space');
await page.screenshot({ path: '.verify/3-walked.png' });

// Enter the parked car and drive.
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
const inCar1 = await page.locator('#hud-weapon').textContent();
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

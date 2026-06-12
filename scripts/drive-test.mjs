// Physics drive test: enter the parked car, floor it, log speed over time,
// then handbrake-turn and check the slide. Needs dev server on :5179.
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
await page.goto('http://localhost:5179/');
await page.click('#btn-start');
await page.waitForFunction(() => window.__world, null, { timeout: 30000 });

// teleport next to the parked car and enter it
const carInfo = await page.evaluate(() => {
  const w = window.__world;
  const car = w.cars.find((c) => !c.driver);
  w.player.pos.x = car.pos.x + 0.5;
  w.player.pos.y = car.pos.y;
  w.player.z = car.z;
  return { model: car.info.model, max: car.handling.maxSpeed, accel: car.handling.accel };
});
console.log('car:', JSON.stringify(carInfo));

await page.keyboard.press('Enter');
await page.waitForTimeout(300);
const entered = await page.evaluate(() => !!window.__world.player.car);
console.log('entered:', entered);

// floor it for 2.5s, sampling speed every 500ms
await page.keyboard.down('ArrowUp');
const samples = [];
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(500);
  samples.push(await page.evaluate(() => +window.__world.player.car?.speed().toFixed(2)));
}
console.log('speed curve:', samples.join(' '));

// handbrake turn at speed — sample mid-slide
await page.keyboard.down('ArrowLeft');
await page.keyboard.down('Space');
let maxLat = 0;
let skidded = false;
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(100);
  const s = await page.evaluate(() => {
    const c = window.__world.player.car;
    if (!c) return null;
    const lat = -c.vel.x * Math.sin(c.heading) + c.vel.y * Math.cos(c.heading);
    return { lat: Math.abs(lat), skidding: c.skidding, speed: c.speed() };
  });
  if (s) {
    maxLat = Math.max(maxLat, s.lat);
    skidded ||= s.skidding;
  }
}
console.log('handbrake slide: maxLat', maxLat.toFixed(2), 'skidded', skidded);
await page.keyboard.up('Space');
await page.keyboard.up('ArrowLeft');
await page.keyboard.up('ArrowUp');

await page.screenshot({ path: '/tmp/drive-test.png' });
await browser.close();
console.log('OK');

import { parseGmp, decodeLid, slopeType, groundType } from '../gta2/gmp';
import { parseSty, TILE_SIZE } from '../gta2/sty';

const status = document.getElementById('status')!;

function log(msg: string): void {
  status.textContent += `\n${msg}`;
}

function putRGBA(ctx: CanvasRenderingContext2D, data: Uint8Array, w: number, h: number, dx: number, dy: number): void {
  const img = new ImageData(new Uint8ClampedArray(data), w, h);
  ctx.putImageData(img, dx, dy);
}

async function main(): Promise<void> {
  const [styBuf, gmpBuf] = await Promise.all([
    fetch('/gamedata/bil.sty').then((r) => r.arrayBuffer()),
    fetch('/gamedata/bil.gmp').then((r) => r.arrayBuffer()),
  ]);
  const sty = parseSty(styBuf);
  const gmp = parseGmp(gmpBuf);
  status.textContent = 'parsed OK';
  log(`tiles: ${sty.tileCount}, sprites: ${sty.sprites.length}, cars: ${sty.cars.length}`);
  log(`palBase: ${JSON.stringify(sty.palBase)}`);
  log(`spriteBase: ${JSON.stringify(sty.spriteBase)}`);
  log(`map blocks: ${gmp.blocks.length}`);

  // --- tiles 0..255 in a 16x16 grid
  {
    const c = document.getElementById('tiles') as HTMLCanvasElement;
    c.width = 16 * TILE_SIZE;
    c.height = 16 * TILE_SIZE;
    const ctx = c.getContext('2d')!;
    for (let t = 0; t < 256 && t < sty.tileCount; t++) {
      putRGBA(ctx, sty.tileRGBA(t), TILE_SIZE, TILE_SIZE, (t % 16) * TILE_SIZE, Math.floor(t / 16) * TILE_SIZE);
    }
  }

  // --- car sprites
  {
    const c = document.getElementById('cars') as HTMLCanvasElement;
    c.width = 10 * 80;
    c.height = 4 * 128;
    const ctx = c.getContext('2d')!;
    const base = 0; // car sprites start at sprite 0
    for (let i = 0; i < 40 && base + i < sty.sprites.length; i++) {
      const s = sty.spriteRGBA(base + i);
      putRGBA(ctx, s.data, s.w, s.h, (i % 10) * 80, Math.floor(i / 10) * 128);
    }
  }

  // --- ped sprites (start after car sprites)
  {
    const c = document.getElementById('peds') as HTMLCanvasElement;
    c.width = 10 * 80;
    c.height = 4 * 80;
    const ctx = c.getContext('2d')!;
    const base = sty.spriteBase.car;
    for (let i = 0; i < 40 && base + i < sty.sprites.length; i++) {
      const s = sty.spriteRGBA(base + i);
      putRGBA(ctx, s.data, s.w, s.h, (i % 10) * 80, Math.floor(i / 10) * 80);
    }
  }

  // --- 2D map render: top lids of a 64x64 block area around map centre
  {
    const c = document.getElementById('map') as HTMLCanvasElement;
    const AREA = 64;
    const PX = 8; // pixels per block
    c.width = AREA * PX;
    c.height = AREA * PX;
    const ctx = c.getContext('2d')!;
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = TILE_SIZE;
    tileCanvas.height = TILE_SIZE;
    const tctx = tileCanvas.getContext('2d')!;
    const cache = new Map<number, HTMLCanvasElement>();
    const tileImg = (t: number): HTMLCanvasElement => {
      let img = cache.get(t);
      if (!img) {
        putRGBA(tctx, sty.tileRGBA(t), TILE_SIZE, TILE_SIZE, 0, 0);
        img = document.createElement('canvas');
        img.width = TILE_SIZE;
        img.height = TILE_SIZE;
        img.getContext('2d')!.drawImage(tileCanvas, 0, 0);
        cache.set(t, img);
      }
      return img;
    };
    let roads = 0;
    let pavement = 0;
    const x0 = 96;
    const y0 = 96;
    for (let y = 0; y < AREA; y++) {
      for (let x = 0; x < AREA; x++) {
        const col = gmp.getColumn(x0 + x, y0 + y);
        for (let i = col.blockIds.length - 1; i >= 0; i--) {
          const b = gmp.blocks[col.blockIds[i]];
          const lid = decodeLid(b.lid);
          if (lid.tile === 0) continue;
          ctx.drawImage(tileImg(lid.tile), x * PX, y * PX, PX, PX);
          const g = groundType(b);
          if (g === 1) roads++;
          else if (g === 2) pavement++;
          void slopeType(b);
          break;
        }
      }
    }
    log(`sample area ground: ${roads} road, ${pavement} pavement blocks`);
  }
  log('RENDER DONE');
}

main().catch((e) => {
  status.textContent = `ERROR: ${e.message}\n${e.stack}`;
});

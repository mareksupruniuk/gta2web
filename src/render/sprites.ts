import { Texture } from 'pixi.js';
import { CarType } from '../sim/car';
import { TILE } from '../sim/types';

/**
 * All sprites are generated procedurally on 2D canvases at SCALE× resolution
 * so the game has no required binary assets. Textures are cached by key.
 */
const SCALE = 2;
const cache = new Map<string, Texture>();

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w * SCALE;
  c.height = h * SCALE;
  const ctx = c.getContext('2d')!;
  ctx.scale(SCALE, SCALE);
  return [c, ctx];
}

function toTexture(key: string, canvas: HTMLCanvasElement): Texture {
  const tex = Texture.from(canvas);
  tex.source.scaleMode = 'nearest';
  cache.set(key, tex);
  return tex;
}

function cached(key: string, build: () => Texture): Texture {
  const hit = cache.get(key);
  return hit ?? build();
}

function hashNoise(ctx: CanvasRenderingContext2D, w: number, h: number, seed: number, alpha: number, light = false): void {
  let s = seed;
  for (let i = 0; i < 60; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const x = s % w;
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const y = s % h;
    ctx.fillStyle = light ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`;
    ctx.fillRect(x, y, 1, 1);
  }
}

// ------------------------------------------------------------------- tiles

export function tileTexture(kind: string, variant = 0): Texture {
  const key = `tile:${kind}:${variant}`;
  return cached(key, () => {
    const [c, ctx] = makeCanvas(TILE, TILE);
    switch (kind) {
      case 'road':
      case 'road_vline':
      case 'road_hline': {
        ctx.fillStyle = '#3a3a3e';
        ctx.fillRect(0, 0, TILE, TILE);
        hashNoise(ctx, TILE, TILE, 7 + variant, 0.18);
        ctx.strokeStyle = 'rgba(232,224,160,0.85)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        if (kind === 'road_vline') {
          ctx.moveTo(0.75, 0);
          ctx.lineTo(0.75, TILE);
        } else if (kind === 'road_hline') {
          ctx.moveTo(0, 0.75);
          ctx.lineTo(TILE, 0.75);
        }
        ctx.stroke();
        break;
      }
      case 'sidewalk': {
        ctx.fillStyle = '#8d8d93';
        ctx.fillRect(0, 0, TILE, TILE);
        hashNoise(ctx, TILE, TILE, 31 + variant, 0.1);
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.lineWidth = 1;
        ctx.strokeRect(0.5, 0.5, TILE - 1, TILE - 1);
        break;
      }
      case 'grass': {
        ctx.fillStyle = '#3e7c3a';
        ctx.fillRect(0, 0, TILE, TILE);
        hashNoise(ctx, TILE, TILE, 101 + variant, 0.15);
        hashNoise(ctx, TILE, TILE, 202 + variant, 0.12, true);
        break;
      }
      case 'water': {
        ctx.fillStyle = '#1b4f72';
        ctx.fillRect(0, 0, TILE, TILE);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
          const y = ((variant * 7 + i * 11) % TILE) + 2;
          ctx.beginPath();
          ctx.moveTo(2, y);
          ctx.quadraticCurveTo(TILE / 2, y - 3, TILE - 2, y);
          ctx.stroke();
        }
        break;
      }
      case 'building': {
        const palettes = [
          ['#6e5e50', '#7d6c5c'],
          ['#5d6570', '#6a737f'],
          ['#74525a', '#825d66'],
          ['#56605a', '#636e67'],
        ];
        // low 2 bits: per-building palette; upper bits: per-tile detail variant
        const detail = variant >> 2;
        const [base, lite] = palettes[variant & 3];
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, TILE, TILE);
        ctx.fillStyle = lite;
        ctx.fillRect(2, 2, TILE - 4, TILE - 4);
        hashNoise(ctx, TILE, TILE, 55 + detail, 0.12);
        // occasional roof furniture
        if (detail % 5 === 0) {
          ctx.fillStyle = '#9aa0a6';
          ctx.fillRect(8, 8, 9, 9);
          ctx.strokeStyle = '#3c4043';
          ctx.strokeRect(8.5, 8.5, 8, 8);
        } else if (detail % 7 === 3) {
          ctx.fillStyle = '#444';
          ctx.beginPath();
          ctx.arc(TILE / 2, TILE / 2, 5, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
    }
    return toTexture(key, c);
  });
}

export function treeTexture(variant = 0): Texture {
  const key = `tree:${variant}`;
  return cached(key, () => {
    const [c, ctx] = makeCanvas(28, 28);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.arc(15, 16, 11, 0, Math.PI * 2);
    ctx.fill();
    const greens = ['#2e6b2a', '#35753a', '#2a6034'];
    ctx.fillStyle = greens[variant % greens.length];
    ctx.beginPath();
    ctx.arc(14, 14, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.arc(11, 11, 5, 0, Math.PI * 2);
    ctx.fill();
    return toTexture(key, c);
  });
}

// -------------------------------------------------------------------- cars

function shade(hex: number, f: number): string {
  const r = Math.min(255, Math.floor(((hex >> 16) & 255) * f));
  const g = Math.min(255, Math.floor(((hex >> 8) & 255) * f));
  const b = Math.min(255, Math.floor((hex & 255) * f));
  return `rgb(${r},${g},${b})`;
}

/** Top-down car, drawn facing +x (right). */
export function carTexture(type: CarType, wrecked = false): Texture {
  const key = `car:${type.id}:${wrecked ? 'wreck' : 'ok'}`;
  return cached(key, () => {
    const L = type.length;
    const W = type.width;
    const [c, ctx] = makeCanvas(L + 4, W + 4);
    ctx.translate(2, 2);
    const body = wrecked ? 0x222222 : type.color;

    // wheels
    ctx.fillStyle = '#1a1a1a';
    for (const wx of [L * 0.16, L * 0.72]) {
      ctx.fillRect(wx, -1, L * 0.14, 2.5);
      ctx.fillRect(wx, W - 1.5, L * 0.14, 2.5);
    }
    // body
    ctx.fillStyle = shade(body, 1);
    roundRect(ctx, 0, 0, L, W, 3.5);
    ctx.fill();
    // hood + trunk shading
    ctx.fillStyle = shade(body, 1.18);
    roundRect(ctx, L * 0.04, W * 0.1, L * 0.92, W * 0.8, 2.5);
    ctx.fill();
    if (!wrecked) {
      // windshield / rear window
      ctx.fillStyle = '#202a33';
      roundRect(ctx, L * 0.52, W * 0.12, L * 0.16, W * 0.76, 1.5);
      ctx.fill();
      roundRect(ctx, L * 0.16, W * 0.16, L * 0.1, W * 0.68, 1.5);
      ctx.fill();
      // roof
      ctx.fillStyle = shade(body, 1.32);
      roundRect(ctx, L * 0.28, W * 0.14, L * 0.22, W * 0.72, 2);
      ctx.fill();
      // headlights
      ctx.fillStyle = '#ffe9a8';
      ctx.fillRect(L - 1.5, W * 0.12, 1.5, W * 0.2);
      ctx.fillRect(L - 1.5, W * 0.68, 1.5, W * 0.2);
      // taillights
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(0, W * 0.12, 1.5, W * 0.18);
      ctx.fillRect(0, W * 0.7, 1.5, W * 0.18);
      if (type.id === 'taxi') {
        ctx.fillStyle = '#111';
        ctx.fillRect(L * 0.34, W * 0.3, L * 0.1, W * 0.4);
      }
    } else {
      ctx.fillStyle = '#3a3a3a';
      roundRect(ctx, L * 0.2, W * 0.15, L * 0.5, W * 0.7, 2);
      ctx.fill();
      hashNoise(ctx, L, W, 13, 0.5);
    }
    return toTexture(key, c);
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// --------------------------------------------------------------------- peds

const SKIN = ['#e0b089', '#c68e63', '#8d5a3b', '#f0c8a0'];
const SHIRT = ['#b03a3a', '#3a5fb0', '#3ab06a', '#b08f3a', '#7a3ab0', '#d07030'];

/** Top-down person facing +x: shoulders + head + hint of arms. variant 0..5, frame 0..1 walk cycle. */
export function pedTexture(variant: number, frame: number, isPlayer = false): Texture {
  const key = `ped:${variant}:${frame}:${isPlayer}`;
  return cached(key, () => {
    const S = 18;
    const [c, ctx] = makeCanvas(S, S);
    const cx = S / 2;
    const cy = S / 2;
    const shirt = isPlayer ? '#d8d8d8' : SHIRT[variant % SHIRT.length];
    const skin = SKIN[variant % SKIN.length];
    const armSwing = frame === 0 ? 2 : -2;

    // arms (fists forward-ish, alternating for walk)
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(cx + 4, cy - 5, 1.8, 0, Math.PI * 2);
    ctx.arc(cx + 4 + (armSwing > 0 ? 1 : 0), cy + 5, 1.8, 0, Math.PI * 2);
    ctx.fill();
    // shoulders (ellipse wider than deep)
    ctx.fillStyle = shirt;
    ctx.beginPath();
    ctx.ellipse(cx, cy, 5, 6.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
    // head
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(cx + 1, cy, 3.1, 0, Math.PI * 2);
    ctx.fill();
    // hair
    ctx.fillStyle = isPlayer ? '#e8d44d' : ['#222', '#5b3a1e', '#777', '#1a1a3a'][variant % 4];
    ctx.beginPath();
    ctx.arc(cx + 0.4, cy, 2.6, Math.PI * 0.6, Math.PI * 1.4);
    ctx.fill();
    return toTexture(key, c);
  });
}

export function corpseTexture(variant: number): Texture {
  const key = `corpse:${variant}`;
  return cached(key, () => {
    const S = 22;
    const [c, ctx] = makeCanvas(S, S);
    const cx = S / 2;
    ctx.fillStyle = 'rgba(150,20,20,0.75)';
    ctx.beginPath();
    ctx.ellipse(cx, cx, 9, 7, 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = SHIRT[variant % SHIRT.length];
    ctx.beginPath();
    ctx.ellipse(cx, cx, 6, 4.5, 0.9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = SKIN[variant % SKIN.length];
    ctx.beginPath();
    ctx.arc(cx + 4.5, cx - 2, 2.8, 0, Math.PI * 2);
    ctx.fill();
    return toTexture(key, c);
  });
}

// ------------------------------------------------------------------- misc

export function bulletTexture(): Texture {
  return cached('bullet', () => {
    const [c, ctx] = makeCanvas(6, 3);
    ctx.fillStyle = '#ffe28a';
    ctx.fillRect(0, 0.5, 6, 2);
    ctx.fillStyle = '#fff';
    ctx.fillRect(4, 1, 2, 1);
    return toTexture('bullet', c);
  });
}

export function pickupTexture(kind: string): Texture {
  const key = `pickup:${kind}`;
  return cached(key, () => {
    const S = 16;
    const [c, ctx] = makeCanvas(S, S);
    // glow pad
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, 7.5, 0, Math.PI * 2);
    ctx.fill();
    if (kind === 'health') {
      ctx.fillStyle = '#e74c3c';
      ctx.fillRect(6.5, 3, 3, 10);
      ctx.fillRect(3, 6.5, 10, 3);
    } else {
      ctx.fillStyle = '#222';
      ctx.strokeStyle = '#ddd';
      ctx.lineWidth = 0.8;
      if (kind === 'pistol') {
        ctx.fillRect(3, 6, 9, 2.6);
        ctx.fillRect(8.5, 8, 2.6, 5);
      } else if (kind === 'uzi') {
        ctx.fillRect(2.5, 6, 11, 3);
        ctx.fillRect(7, 8.5, 2.5, 5);
        ctx.fillRect(12, 4.5, 1.5, 3);
      } else {
        // shotgun
        ctx.fillStyle = '#5b3a1e';
        ctx.fillRect(2, 7, 5, 2.6);
        ctx.fillStyle = '#222';
        ctx.fillRect(6, 6.8, 8, 3);
      }
    }
    return toTexture(key, c);
  });
}

export function muzzleTexture(): Texture {
  return cached('muzzle', () => {
    const [c, ctx] = makeCanvas(14, 14);
    const g = ctx.createRadialGradient(7, 7, 0, 7, 7, 7);
    g.addColorStop(0, 'rgba(255,255,220,1)');
    g.addColorStop(0.4, 'rgba(255,200,60,0.9)');
    g.addColorStop(1, 'rgba(255,120,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 14, 14);
    return toTexture('muzzle', c);
  });
}

export function bloodTexture(variant: number): Texture {
  const key = `blood:${variant}`;
  return cached(key, () => {
    const S = 18;
    const [c, ctx] = makeCanvas(S, S);
    ctx.fillStyle = 'rgba(140,15,15,0.8)';
    let s = variant * 31 + 7;
    for (let i = 0; i < 7; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const x = 3 + (s % (S - 6));
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const y = 3 + (s % (S - 6));
      const r = 1.5 + (s % 30) / 10;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    return toTexture(key, c);
  });
}

export function smokeTexture(): Texture {
  return cached('smoke', () => {
    const [c, ctx] = makeCanvas(20, 20);
    const g = ctx.createRadialGradient(10, 10, 1, 10, 10, 10);
    g.addColorStop(0, 'rgba(60,60,60,0.85)');
    g.addColorStop(1, 'rgba(60,60,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 20, 20);
    return toTexture('smoke', c);
  });
}

export function fireTexture(): Texture {
  return cached('fire', () => {
    const [c, ctx] = makeCanvas(20, 20);
    const g = ctx.createRadialGradient(10, 10, 1, 10, 10, 10);
    g.addColorStop(0, 'rgba(255,240,180,1)');
    g.addColorStop(0.45, 'rgba(255,140,30,0.9)');
    g.addColorStop(1, 'rgba(200,40,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 20, 20);
    return toTexture('fire', c);
  });
}

import { Application, Container, RenderTexture, Sprite, Texture, Ticker } from 'pixi.js';
import { GameMap } from '../sim/map';
import { Dir, GameEvent, TILE, Tile, Vec2 } from '../sim/types';
import { World } from '../sim/world';
import {
  bloodTexture, bulletTexture, carTexture, corpseTexture, fireTexture,
  muzzleTexture, pedTexture, pickupTexture, smokeTexture, tileTexture, treeTexture,
} from './sprites';

interface Effect {
  sprite: Sprite;
  ttl: number;
  life: number;
  vel?: Vec2;
  grow?: number;
  fade?: boolean;
}

const MAX_DECALS = 250;

export class Renderer {
  readonly app: Application;
  private camera = new Container();
  private decals = new Container();
  private pickupLayer = new Container();
  private corpseLayer = new Container();
  private carLayer = new Container();
  private actorLayer = new Container();
  private fxLayer = new Container();
  private carSprites = new Map<number, Sprite>();
  private wrecked = new Set<number>();
  private pedSprites = new Map<number, Sprite>();
  private corpses = new Set<number>();
  private bulletSprites = new Map<number, Sprite>();
  private pickupSprites: Sprite[] = [];
  private playerSprite: Sprite;
  private effects: Effect[] = [];
  private zoom = 1.5;
  private shake = 0;
  private animTime = 0;

  private constructor(app: Application, world: World) {
    this.app = app;
    app.stage.addChild(this.camera);
    this.camera.addChild(this.buildGround(world.map));
    this.camera.addChild(this.decals, this.pickupLayer, this.corpseLayer, this.carLayer, this.actorLayer, this.fxLayer);

    this.playerSprite = new Sprite(pedTexture(0, 0, true));
    this.playerSprite.anchor.set(0.5);
    this.actorLayer.addChild(this.playerSprite);

    for (const p of world.pickups) {
      const s = new Sprite(pickupTexture(p.kind));
      s.anchor.set(0.5);
      s.position.set(p.pos.x, p.pos.y);
      this.pickupLayer.addChild(s);
      this.pickupSprites.push(s);
    }
  }

  static async create(world: World, mount: HTMLElement): Promise<Renderer> {
    const app = new Application();
    await app.init({
      resizeTo: mount,
      background: 0x0a0a0a,
      antialias: false,
      preference: 'webgl',
    });
    mount.appendChild(app.canvas);
    return new Renderer(app, world);
  }

  destroy(): void {
    this.app.destroy(true, { children: true, texture: false });
  }

  /** Bake the whole tile map (plus trees) into one big texture. */
  private buildGround(map: GameMap): Sprite {
    const temp = new Container();
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const t = map.tileAt(x, y);
        const h = (x * 73856093) ^ (y * 19349663);
        const variant = Math.abs(h) % 8;
        let tex: Texture;
        switch (t) {
          case Tile.Road:
          case Tile.RoadMarking: {
            const f = map.flowAt(x, y);
            const lf = map.flowAt(x - 1, y);
            const tf = map.flowAt(x, y - 1);
            if (f === 1 << Dir.N && lf === 1 << Dir.S) tex = tileTexture('road_vline', variant);
            else if (f === 1 << Dir.E && tf === 1 << Dir.W) tex = tileTexture('road_hline', variant);
            else tex = tileTexture('road', variant);
            break;
          }
          case Tile.Sidewalk:
            tex = tileTexture('sidewalk', variant);
            break;
          case Tile.Building:
            tex = tileTexture('building', variant);
            break;
          case Tile.Water:
            tex = tileTexture('water', variant);
            break;
          default:
            tex = tileTexture('grass', variant);
        }
        const s = new Sprite(tex);
        s.position.set(x * TILE, y * TILE);
        s.width = TILE;
        s.height = TILE;
        temp.addChild(s);
        if (t === Tile.Grass && Math.abs(h >> 3) % 11 === 0) {
          const tree = new Sprite(treeTexture(Math.abs(h) % 3));
          tree.position.set(x * TILE + 2, y * TILE + 2);
          temp.addChild(tree);
        }
      }
    }
    const rt = RenderTexture.create({ width: map.width * TILE, height: map.height * TILE });
    this.app.renderer.render({ container: temp, target: rt });
    temp.destroy({ children: true });
    return new Sprite(rt);
  }

  /** Spawn one-off visual effects from sim events. */
  handleEvents(events: GameEvent[], world: World): void {
    for (const e of events) {
      switch (e.type) {
        case 'shot': {
          if (e.weapon === 'fists') break;
          const h = world.player.heading;
          this.addEffect(muzzleTexture(), {
            x: e.pos.x + Math.cos(h) * 14,
            y: e.pos.y + Math.sin(h) * 14,
          }, 0.06, { fade: true });
          break;
        }
        case 'hit':
          this.addEffect(muzzleTexture(), e.pos, 0.08, { fade: true, scale: 0.5 });
          break;
        case 'ped_killed':
          this.addDecal(bloodTexture(Math.floor(Math.random() * 6)), e.pos);
          break;
        case 'car_crash':
          if (e.speed > 100) this.addEffect(smokeTexture(), e.pos, 0.4, { fade: true, grow: 1.5 });
          break;
        case 'explosion': {
          this.shake = Math.max(this.shake, 0.45);
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2;
            const sp = 30 + Math.random() * 90;
            this.addEffect(fireTexture(), e.pos, 0.5 + Math.random() * 0.3, {
              fade: true, grow: 2.2,
              vel: { x: Math.cos(a) * sp, y: Math.sin(a) * sp },
            });
          }
          for (let i = 0; i < 6; i++) {
            this.addEffect(smokeTexture(), e.pos, 1.2 + Math.random() * 0.8, {
              fade: true, grow: 2.5,
              vel: { x: (Math.random() - 0.5) * 40, y: (Math.random() - 0.5) * 40 - 15 },
            });
          }
          this.addDecal(bloodTexture(3), e.pos, 0x222222, 3);
          break;
        }
      }
    }
  }

  private addEffect(tex: Texture, pos: Vec2, ttl: number, opts: { fade?: boolean; grow?: number; vel?: Vec2; scale?: number } = {}): void {
    const s = new Sprite(tex);
    s.anchor.set(0.5);
    s.position.set(pos.x, pos.y);
    if (opts.scale) s.scale.set(opts.scale);
    this.fxLayer.addChild(s);
    this.effects.push({ sprite: s, ttl, life: ttl, vel: opts.vel, grow: opts.grow, fade: opts.fade });
  }

  private addDecal(tex: Texture, pos: Vec2, tint = 0xffffff, scale = 1): void {
    const s = new Sprite(tex);
    s.anchor.set(0.5);
    s.position.set(pos.x, pos.y);
    s.rotation = Math.random() * Math.PI * 2;
    s.tint = tint;
    s.scale.set(scale);
    this.decals.addChild(s);
    if (this.decals.children.length > MAX_DECALS) {
      this.decals.children[0].destroy();
    }
  }

  /** Per-frame: sync sprites to sim state, advance effects, move camera. */
  update(dt: number, world: World, ticker: Ticker): void {
    void ticker;
    this.animTime += dt;
    this.syncCars(world);
    this.syncPeds(world);
    this.syncBullets(world);
    this.syncPickups(world);
    this.syncPlayer(world);
    this.updateEffects(dt);
    this.updateCamera(dt, world);
  }

  private syncCars(world: World): void {
    const seen = new Set<number>();
    for (const car of world.cars) {
      seen.add(car.id);
      let s = this.carSprites.get(car.id);
      if (!s) {
        s = new Sprite(carTexture(car.type));
        s.anchor.set(0.5);
        this.carLayer.addChild(s);
        this.carSprites.set(car.id, s);
      }
      if (car.exploded && !this.wrecked.has(car.id)) {
        s.texture = carTexture(car.type, true);
        this.wrecked.add(car.id);
      }
      s.position.set(car.pos.x, car.pos.y);
      s.rotation = car.heading;
    }
    for (const [id, s] of this.carSprites) {
      if (!seen.has(id)) {
        s.destroy();
        this.carSprites.delete(id);
        this.wrecked.delete(id);
      }
    }
  }

  private syncPeds(world: World): void {
    const seen = new Set<number>();
    for (const ped of world.peds) {
      seen.add(ped.id);
      let s = this.pedSprites.get(ped.id);
      if (!s) {
        s = new Sprite(pedTexture(ped.variant, 0));
        s.anchor.set(0.5);
        this.actorLayer.addChild(s);
        this.pedSprites.set(ped.id, s);
      }
      if (ped.dead) {
        if (!this.corpses.has(ped.id)) {
          s.texture = corpseTexture(ped.variant);
          this.actorLayer.removeChild(s);
          this.corpseLayer.addChild(s);
          this.corpses.add(ped.id);
        }
      } else {
        const frame = Math.floor(this.animTime * 6 + ped.id) % 2;
        s.texture = pedTexture(ped.variant, frame);
        s.rotation = ped.heading;
      }
      s.position.set(ped.pos.x, ped.pos.y);
    }
    for (const [id, s] of this.pedSprites) {
      if (!seen.has(id)) {
        s.destroy();
        this.pedSprites.delete(id);
        this.corpses.delete(id);
      }
    }
  }

  private syncBullets(world: World): void {
    const seen = new Set<number>();
    for (const b of world.bullets) {
      seen.add(b.id);
      let s = this.bulletSprites.get(b.id);
      if (!s) {
        s = new Sprite(bulletTexture());
        s.anchor.set(0.5);
        s.rotation = Math.atan2(b.vel.y, b.vel.x);
        this.fxLayer.addChild(s);
        this.bulletSprites.set(b.id, s);
      }
      s.position.set(b.pos.x, b.pos.y);
    }
    for (const [id, s] of this.bulletSprites) {
      if (!seen.has(id)) {
        s.destroy();
        this.bulletSprites.delete(id);
      }
    }
  }

  private syncPickups(world: World): void {
    const pulse = 1 + Math.sin(this.animTime * 4) * 0.12;
    world.pickups.forEach((p, i) => {
      const s = this.pickupSprites[i];
      s.visible = p.respawnIn === 0;
      s.scale.set(pulse);
    });
  }

  private syncPlayer(world: World): void {
    const p = world.player;
    this.playerSprite.visible = !p.car && !p.dead;
    if (p.dead && this.playerSprite.visible) this.playerSprite.visible = false;
    const moving = true;
    const frame = moving ? Math.floor(this.animTime * 7) % 2 : 0;
    this.playerSprite.texture = pedTexture(0, frame, true);
    this.playerSprite.position.set(p.pos.x, p.pos.y);
    this.playerSprite.rotation = p.heading;
  }

  private updateEffects(dt: number): void {
    this.effects = this.effects.filter((e) => {
      e.ttl -= dt;
      if (e.ttl <= 0) {
        e.sprite.destroy();
        return false;
      }
      const t = 1 - e.ttl / e.life;
      if (e.vel) {
        e.sprite.x += e.vel.x * dt;
        e.sprite.y += e.vel.y * dt;
      }
      if (e.grow) e.sprite.scale.set(1 + t * e.grow);
      if (e.fade) e.sprite.alpha = 1 - t;
      return true;
    });
  }

  private updateCamera(dt: number, world: World): void {
    const p = world.player;
    const speed = p.car ? p.car.speed() : 0;
    const targetZoom = p.car ? 1.5 - Math.min(0.55, speed / 400) : 1.5;
    this.zoom += (targetZoom - this.zoom) * Math.min(1, dt * 2.5);

    this.shake = Math.max(0, this.shake - dt);
    const sx = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 28 : 0;
    const sy = this.shake > 0 ? (Math.random() - 0.5) * this.shake * 28 : 0;

    const w = this.app.renderer.width;
    const h = this.app.renderer.height;
    this.camera.scale.set(this.zoom);
    this.camera.position.set(
      w / 2 - p.pos.x * this.zoom + sx,
      h / 2 - p.pos.y * this.zoom + sy,
    );
  }
}

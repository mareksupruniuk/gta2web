import { Rng } from '../sim/rng';
import { GameEvent, Vec2, dist } from '../sim/types';
import { Sty } from '../gta2/sty';
import { CityMap } from './citymap';
import { Ped2 } from './ped2';
import { Bullet, WEAPONS } from './weapons2';
import type { Player2 } from './world2';

/**
 * GTA2 gangs from the map's ZONE data (type 14), all three districts:
 * Downtown (Yakuza/Loonies/Zaibatsu), Residential (Rednecks/SRS Scientists/
 * Alma Mater/Zaibatsu), Industrial (Hare Krishna/Russian Mafia/Zaibatsu).
 * Members patrol their turf armed; hurting a gang turns it hostile.
 * Member colours are resolved per style file at load by sampling the ped
 * remap palettes for each gang's signature colour (resolveGangRemaps).
 */

export type GangId = string;

export interface GangDef {
  id: GangId;
  name: string;
  /** matches this gang's ZONE names ("yakuzagang", "zaibgang", ...) */
  zoneMatch: RegExp;
  /** signature clothing colour to look for in the ped remap palettes */
  color: [number, number, number];
}

export const GANGS: GangDef[] = [
  { id: 'yakuza', name: 'Yakuza', zoneMatch: /yakuza/i, color: [50, 65, 90] },
  { id: 'loonies', name: 'Loonies', zoneMatch: /loonie/i, color: [60, 105, 65] },
  { id: 'zaibatsu', name: 'Zaibatsu', zoneMatch: /zaib/i, color: [40, 35, 50] },
  { id: 'rednecks', name: 'Rednecks', zoneMatch: /redn/i, color: [115, 45, 28] },
  { id: 'scientists', name: 'SRS Scientists', zoneMatch: /scie/i, color: [125, 120, 115] },
  { id: 'almamater', name: 'Alma Mater', zoneMatch: /alma/i, color: [95, 70, 45] },
  { id: 'krishna', name: 'Hare Krishna', zoneMatch: /kris/i, color: [145, 85, 30] },
  { id: 'russians', name: 'Russian Mafia', zoneMatch: /russ/i, color: [85, 85, 95] },
];

/**
 * Pick a distinct ped remap per gang whose average sprite colour is closest
 * to the gang's signature colour. Sampled from the style's civilian walk
 * sprite so it adapts to each district's palette set.
 */
export function resolveGangRemaps(sty: Sty, gangs: GangDef[]): Map<GangId, number> {
  const out = new Map<GangId, number>();
  const sprite = sty.spriteBase.car + 158; // civilian set, walk frame 0
  const n = sty.palBase.pedRemap;
  const avgs: [number, number, number][] = [];
  for (let r = 0; r < n; r++) {
    const { w, h, data } = sty.spriteRGBA(sprite, sty.pedRemapPalette(r));
    let R = 0, G = 0, B = 0, c = 0;
    for (let i = 0; i < w * h; i++) {
      if (data[i * 4 + 3] < 128) continue;
      R += data[i * 4]; G += data[i * 4 + 1]; B += data[i * 4 + 2]; c++;
    }
    avgs.push(c ? [R / c, G / c, B / c] : [0, 0, 0]);
  }
  const taken = new Set<number>();
  for (const g of gangs) {
    let best = 0;
    let bestD = Infinity;
    for (let r = 0; r < avgs.length; r++) {
      if (taken.has(r)) continue;
      const [ar, ag, ab] = avgs[r];
      const d = (ar - g.color[0]) ** 2 + (ag - g.color[1]) ** 2 + (ab - g.color[2]) ** 2;
      if (d < bestD) { bestD = d; best = r; }
    }
    taken.add(best);
    out.set(g.id, best);
  }
  return out;
}

export interface GangTurf {
  gang: GangDef;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Gang turf rects from the map's type-14 zones. */
export function gangTurfs(zones: { type: number; name: string; x: number; y: number; w: number; h: number }[]): GangTurf[] {
  const out: GangTurf[] = [];
  for (const z of zones) {
    if (z.type !== 14) continue;
    const gang = GANGS.find((g) => g.zoneMatch.test(z.name));
    if (gang) out.push({ gang, x: z.x, y: z.y, w: z.w, h: z.h });
  }
  return out;
}

export function turfAt(turfs: GangTurf[], pos: Vec2): GangTurf | null {
  for (const t of turfs) {
    if (pos.x >= t.x && pos.x < t.x + t.w && pos.y >= t.y && pos.y < t.y + t.h) return t;
  }
  return null;
}

const SHOOT_RANGE = 4.5;
const SHOOT_INTERVAL = 0.9;
const CHASE_SPEED = 1.7;
const GIVE_UP_DIST = 11;

/** An armed gang member: patrols the turf, shoots the player when hostile. */
export class GangMember extends Ped2 {
  readonly gang: GangDef;
  /** renderer shows the firing stance briefly after a shot */
  shooting = false;
  private shootCooldown = 0;

  constructor(pos: Vec2, z: number, gang: GangDef, remap: number) {
    super(pos, z, remap);
    this.gang = gang;
    this.health = 30; // tougher than civilians
  }

  updateMember(
    dt: number,
    map: CityMap,
    rng: Rng,
    emit: (e: GameEvent) => void,
    player: Player2,
    hostile: boolean,
    bullets: Bullet[],
  ): void {
    if (this.dead) return;
    this.shootCooldown = Math.max(0, this.shootCooldown - dt);
    this.shooting = this.shootCooldown > SHOOT_INTERVAL - 0.3;

    const d = dist(this.pos, player.pos);
    const engaged =
      hostile && !this.onFire && !player.dead && d < GIVE_UP_DIST && Math.abs(this.z - player.z) < 1;
    if (!engaged) {
      this.update(dt, map, rng, emit); // regular ped wandering / fleeing / burning
      return;
    }

    this.animTime += dt;
    this.heading = Math.atan2(player.pos.y - this.pos.y, player.pos.x - this.pos.x);

    if (d < SHOOT_RANGE && this.shootCooldown === 0) {
      const a = this.heading + (rng.next() - 0.5) * 0.15;
      const b = new Bullet(
        { x: this.pos.x + Math.cos(a) * 0.2, y: this.pos.y + Math.sin(a) * 0.2 },
        this.z + 0.5,
        a,
        WEAPONS.uzi,
      );
      b.hostile = true;
      b.pedDamage = 6; // gang fire wounds the player gradually
      bullets.push(b);
      emit({ type: 'shot', weapon: 'uzi', pos: { ...this.pos } });
      this.shootCooldown = SHOOT_INTERVAL;
      return; // plant feet to fire
    }

    // close the distance
    const nx = this.pos.x + Math.cos(this.heading) * CHASE_SPEED * dt;
    const ny = this.pos.y + Math.sin(this.heading) * CHASE_SPEED * dt;
    if (map.canMoveBody(this.pos.x, this.pos.y, nx, this.pos.y, this.z, 0.13, 0.6)) this.pos.x = nx;
    if (map.canMoveBody(this.pos.x, this.pos.y, this.pos.x, ny, this.z, 0.13, 0.6)) this.pos.y = ny;
    const g = map.groundZ(this.pos.x, this.pos.y, this.z + 0.55);
    if (g !== null) this.z = g < this.z - 0.05 ? Math.max(g, this.z - 4 * dt) : g;
  }
}

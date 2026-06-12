import { Rng } from '../sim/rng';
import { GameEvent, Vec2, dist } from '../sim/types';
import { CityMap } from './citymap';
import { Ped2 } from './ped2';
import { Bullet, WEAPONS } from './weapons2';
import type { Player2 } from './world2';

/**
 * GTA2 gangs from the map's ZONE data (type 14). Downtown: Yakuza (blue),
 * Loonies (green), Zaibatsu (dark). Members patrol their turf armed; hurting
 * a gang turns it hostile — its members open fire on sight inside the turf.
 * Remaps chosen by sampling the style's ped remap palettes for the gang
 * colours (scripts in repo history).
 */

export type GangId = 'yakuza' | 'loonies' | 'zaibatsu';

export interface GangDef {
  id: GangId;
  name: string;
  /** ped remap (virtual, ped remap area) for member colours */
  remap: number;
  /** matches this gang's ZONE names (e.g. "yakuzagang") */
  zoneMatch: RegExp;
}

export const GANGS: GangDef[] = [
  { id: 'yakuza', name: 'Yakuza', remap: 0, zoneMatch: /yakuza/i },
  { id: 'loonies', name: 'Loonies', remap: 16, zoneMatch: /loonie/i },
  { id: 'zaibatsu', name: 'Zaibatsu', remap: 13, zoneMatch: /zaibatsu/i },
];

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

  constructor(pos: Vec2, z: number, gang: GangDef) {
    super(pos, z, gang.remap);
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

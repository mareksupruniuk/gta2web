import { Vec2, WeaponId } from './types';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  damage: number;
  /** seconds between shots */
  fireInterval: number;
  /** bullets per trigger pull (shotgun pellets) */
  pellets: number;
  /** total spread angle in radians */
  spread: number;
  bulletSpeed: number;
  range: number;
  automatic: boolean;
  /** ammo granted by a pickup; Infinity for fists */
  pickupAmmo: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  fists: {
    id: 'fists', name: 'FISTS', damage: 8, fireInterval: 0.45, pellets: 1,
    spread: 0, bulletSpeed: 0, range: 22, automatic: false, pickupAmmo: Infinity,
  },
  pistol: {
    id: 'pistol', name: 'PISTOL', damage: 12, fireInterval: 0.35, pellets: 1,
    spread: 0.03, bulletSpeed: 600, range: 380, automatic: false, pickupAmmo: 24,
  },
  uzi: {
    id: 'uzi', name: 'UZI', damage: 7, fireInterval: 0.09, pellets: 1,
    spread: 0.09, bulletSpeed: 620, range: 340, automatic: true, pickupAmmo: 60,
  },
  shotgun: {
    id: 'shotgun', name: 'SHOTGUN', damage: 9, fireInterval: 0.8, pellets: 6,
    spread: 0.28, bulletSpeed: 540, range: 220, automatic: false, pickupAmmo: 12,
  },
};

export const WEAPON_ORDER: WeaponId[] = ['fists', 'pistol', 'uzi', 'shotgun'];

let nextId = 1;

export class Bullet {
  readonly id = nextId++;
  pos: Vec2;
  vel: Vec2;
  /** remaining travel distance */
  remaining: number;
  damage: number;
  /** entity that fired it (so you can't shoot yourself / your car) */
  ownerId: number;

  constructor(pos: Vec2, angle: number, def: WeaponDef, ownerId: number) {
    this.pos = { ...pos };
    this.vel = { x: Math.cos(angle) * def.bulletSpeed, y: Math.sin(angle) * def.bulletSpeed };
    this.remaining = def.range;
    this.damage = def.damage;
    this.ownerId = ownerId;
  }
}

/** Player's weapon inventory: which weapons are held and with how much ammo. */
export class Inventory {
  ammo = new Map<WeaponId, number>([['fists', Infinity]]);
  current: WeaponId = 'fists';
  private cooldown = 0;

  has(id: WeaponId): boolean {
    return (this.ammo.get(id) ?? 0) > 0;
  }

  add(id: WeaponId, amount: number): void {
    this.ammo.set(id, (this.ammo.get(id) ?? 0) + amount);
    this.current = id;
  }

  currentDef(): WeaponDef {
    return WEAPONS[this.current];
  }

  currentAmmo(): number {
    return this.ammo.get(this.current) ?? 0;
  }

  /** Cycle to next/previous held weapon. */
  cycle(step: 1 | -1): void {
    const held = WEAPON_ORDER.filter((w) => this.has(w));
    const i = held.indexOf(this.current);
    this.current = held[(i + step + held.length) % held.length];
  }

  tick(dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
  }

  /**
   * Attempt to fire. Returns true if a shot happened (caller spawns bullets).
   * Consumes ammo and starts the cooldown. Falls back to fists at 0 ammo.
   */
  tryFire(): boolean {
    if (this.cooldown > 0) return false;
    const ammo = this.ammo.get(this.current) ?? 0;
    if (ammo <= 0) return false;
    const def = WEAPONS[this.current];
    if (ammo !== Infinity) {
      const left = ammo - 1;
      this.ammo.set(this.current, left);
      if (left <= 0) {
        this.ammo.delete(this.current);
        this.current = 'fists';
      }
    }
    this.cooldown = def.fireInterval;
    return true;
  }
}

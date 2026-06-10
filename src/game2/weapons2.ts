import { Vec2, WeaponId } from '../sim/types';

/** Weapon definitions in block units (1 block = 1.0, GTA2's 64px). */

export interface WeaponDef {
  id: WeaponId;
  name: string;
  damage: number;
  fireInterval: number;
  pellets: number;
  spread: number;
  bulletSpeed: number; // blocks/s
  range: number; // blocks
  automatic: boolean;
  pickupAmmo: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  fists: {
    id: 'fists', name: 'FISTS', damage: 8, fireInterval: 0.45, pellets: 1,
    spread: 0, bulletSpeed: 0, range: 0.4, automatic: false, pickupAmmo: Infinity,
  },
  pistol: {
    id: 'pistol', name: 'PISTOL', damage: 12, fireInterval: 0.35, pellets: 1,
    spread: 0.03, bulletSpeed: 11, range: 6.5, automatic: false, pickupAmmo: 24,
  },
  uzi: {
    id: 'uzi', name: 'MACHINE GUN', damage: 7, fireInterval: 0.09, pellets: 1,
    spread: 0.09, bulletSpeed: 11.5, range: 6, automatic: true, pickupAmmo: 60,
  },
  shotgun: {
    id: 'shotgun', name: 'SHOTGUN', damage: 9, fireInterval: 0.8, pellets: 6,
    spread: 0.28, bulletSpeed: 10, range: 4, automatic: false, pickupAmmo: 12,
  },
};

export const WEAPON_ORDER: WeaponId[] = ['fists', 'pistol', 'uzi', 'shotgun'];

let nextId = 1;

export class Bullet {
  readonly id = nextId++;
  pos: Vec2;
  z: number;
  vel: Vec2;
  remaining: number;
  damage: number;

  constructor(pos: Vec2, z: number, angle: number, def: WeaponDef) {
    this.pos = { ...pos };
    this.z = z;
    this.vel = { x: Math.cos(angle) * def.bulletSpeed, y: Math.sin(angle) * def.bulletSpeed };
    this.remaining = def.range;
    this.damage = def.damage;
  }
}

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

  cycle(step: 1 | -1): void {
    const held = WEAPON_ORDER.filter((w) => this.has(w));
    const i = held.indexOf(this.current);
    this.current = held[(i + step + held.length) % held.length];
  }

  tick(dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
  }

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

import { Vec2, WeaponId } from '../sim/types';

/** Weapon definitions in block units (1 block = 1.0, GTA2's 64px). */

export type WeaponKind = 'melee' | 'bullet' | 'rocket' | 'thrown' | 'flame' | 'beam';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  kind: WeaponKind;
  /** damage against peds — in GTA2 every gun kills an unarmoured ped outright */
  pedDamage: number;
  /** damage against vehicles per bullet/pellet (or per second for beam/flame) */
  carDamage: number;
  fireInterval: number;
  pellets: number;
  spread: number;
  bulletSpeed: number; // blocks/s
  range: number; // blocks
  automatic: boolean;
  pickupAmmo: number;
  /** silenced weapons don't panic the whole street */
  silenced?: boolean;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  fists: {
    id: 'fists', name: 'FISTS', kind: 'melee', pedDamage: 8, carDamage: 0,
    fireInterval: 0.45, pellets: 1, spread: 0, bulletSpeed: 0, range: 0.4,
    automatic: false, pickupAmmo: Infinity,
  },
  pistol: {
    id: 'pistol', name: 'PISTOL', kind: 'bullet', pedDamage: 100, carDamage: 7,
    fireInterval: 0.4, pellets: 1, spread: 0.025, bulletSpeed: 11, range: 6.5,
    automatic: false, pickupAmmo: 24,
  },
  dual_pistol: {
    id: 'dual_pistol', name: 'DUAL PISTOLS', kind: 'bullet', pedDamage: 100, carDamage: 7,
    fireInterval: 0.32, pellets: 2, spread: 0.05, bulletSpeed: 11, range: 6.5,
    automatic: false, pickupAmmo: 40,
  },
  uzi: {
    id: 'uzi', name: 'MACHINE GUN', kind: 'bullet', pedDamage: 100, carDamage: 4,
    fireInterval: 0.105, pellets: 1, spread: 0.085, bulletSpeed: 11.5, range: 5.5,
    automatic: true, pickupAmmo: 60,
  },
  s_uzi: {
    id: 's_uzi', name: 'S-UZI', kind: 'bullet', pedDamage: 100, carDamage: 3,
    fireInterval: 0.08, pellets: 1, spread: 0.11, bulletSpeed: 11, range: 4.5,
    automatic: true, pickupAmmo: 50,
  },
  silenced_s_uzi: {
    id: 'silenced_s_uzi', name: 'SILENCED S-UZI', kind: 'bullet', pedDamage: 100, carDamage: 3,
    fireInterval: 0.09, pellets: 1, spread: 0.09, bulletSpeed: 11, range: 4.5,
    automatic: true, pickupAmmo: 50, silenced: true,
  },
  shotgun: {
    id: 'shotgun', name: 'SHOTGUN', kind: 'bullet', pedDamage: 100, carDamage: 6,
    fireInterval: 0.85, pellets: 6, spread: 0.3, bulletSpeed: 10, range: 3.5,
    automatic: false, pickupAmmo: 12,
  },
  rocket: {
    id: 'rocket', name: 'ROCKET LAUNCHER', kind: 'rocket', pedDamage: 100, carDamage: 70,
    fireInterval: 1.4, pellets: 1, spread: 0, bulletSpeed: 7, range: 9,
    automatic: false, pickupAmmo: 5,
  },
  flamethrower: {
    id: 'flamethrower', name: 'FLAMETHROWER', kind: 'flame', pedDamage: 100, carDamage: 18,
    fireInterval: 0.045, pellets: 1, spread: 0.18, bulletSpeed: 3.2, range: 2.2,
    automatic: true, pickupAmmo: 80,
  },
  electrogun: {
    id: 'electrogun', name: 'ELECTROGUN', kind: 'beam', pedDamage: 100, carDamage: 30,
    fireInterval: 0.12, pellets: 1, spread: 0, bulletSpeed: 0, range: 4,
    automatic: true, pickupAmmo: 90,
  },
  grenade: {
    id: 'grenade', name: 'GRENADES', kind: 'thrown', pedDamage: 0, carDamage: 0,
    fireInterval: 0.9, pellets: 1, spread: 0, bulletSpeed: 4.5, range: 4,
    automatic: false, pickupAmmo: 6,
  },
  molotov: {
    id: 'molotov', name: 'MOLOTOVS', kind: 'thrown', pedDamage: 0, carDamage: 0,
    fireInterval: 0.9, pellets: 1, spread: 0, bulletSpeed: 4.5, range: 4,
    automatic: false, pickupAmmo: 6,
  },
};

export const WEAPON_ORDER: WeaponId[] = [
  'fists', 'pistol', 'dual_pistol', 'uzi', 's_uzi', 'silenced_s_uzi',
  'shotgun', 'flamethrower', 'electrogun', 'grenade', 'molotov', 'rocket',
];

let nextId = 1;

export class Bullet {
  readonly id = nextId++;
  pos: Vec2;
  z: number;
  vel: Vec2;
  angle: number;
  remaining: number;
  pedDamage: number;
  carDamage: number;
  /** rockets explode on impact instead of just damaging */
  isRocket = false;

  constructor(pos: Vec2, z: number, angle: number, def: WeaponDef) {
    this.pos = { ...pos };
    this.z = z;
    this.angle = angle;
    this.vel = { x: Math.cos(angle) * def.bulletSpeed, y: Math.sin(angle) * def.bulletSpeed };
    this.remaining = def.range;
    this.pedDamage = def.pedDamage;
    this.carDamage = def.carDamage;
  }
}

/** Grenade / molotov in flight: ballistic arc with a little gravity. */
export class Thrown {
  readonly id = nextId++;
  kind: 'grenade' | 'molotov';
  pos: Vec2;
  z: number;
  vz: number;
  vel: Vec2;
  /** grenade fuse seconds; molotovs smash on landing */
  fuse: number;
  landed = false;

  constructor(kind: 'grenade' | 'molotov', pos: Vec2, z: number, angle: number, speed: number) {
    this.kind = kind;
    this.pos = { ...pos };
    this.z = z + 0.5;
    this.vz = 1.6;
    this.vel = { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed };
    this.fuse = 2.2;
  }
}

/** Short-lived flamethrower jet particle. */
export class Flame {
  readonly id = nextId++;
  pos: Vec2;
  z: number;
  vel: Vec2;
  ttl: number;
  readonly maxTtl: number;

  constructor(pos: Vec2, z: number, angle: number, speed: number, ttl: number) {
    this.pos = { ...pos };
    this.z = z;
    this.vel = { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed };
    this.ttl = ttl;
    this.maxTtl = ttl;
  }

  get age(): number {
    return 1 - this.ttl / this.maxTtl;
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

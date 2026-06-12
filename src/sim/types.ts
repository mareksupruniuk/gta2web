export interface Vec2 {
  x: number;
  y: number;
}

export function vec(x = 0, y = 0): Vec2 {
  return { x, y };
}

export function len(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function angleTo(from: Vec2, to: Vec2): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/** Wraps an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a <= -Math.PI) a += Math.PI * 2;
  return a;
}

/** Shortest signed difference between two angles. */
export function angleDiff(a: number, b: number): number {
  return wrapAngle(b - a);
}

export const TILE = 32; // world units per tile

export enum Tile {
  Road = 0,
  Sidewalk = 1,
  Building = 2,
  Grass = 3,
  Water = 4,
  RoadMarking = 5, // road with painted center line (drives like road)
}

/** Cardinal traffic-flow direction for road tiles, used by AI drivers. */
export enum Dir {
  None = 0,
  N = 1,
  E = 2,
  S = 3,
  W = 4,
}

export const DIR_VEC: Record<Dir, Vec2> = {
  [Dir.None]: { x: 0, y: 0 },
  [Dir.N]: { x: 0, y: -1 },
  [Dir.E]: { x: 1, y: 0 },
  [Dir.S]: { x: 0, y: 1 },
  [Dir.W]: { x: -1, y: 0 },
};

export const DIR_ANGLE: Record<Dir, number> = {
  [Dir.None]: 0,
  [Dir.N]: -Math.PI / 2,
  [Dir.E]: 0,
  [Dir.S]: Math.PI / 2,
  [Dir.W]: Math.PI,
};

export type WeaponId =
  | 'fists'
  | 'pistol'
  | 'dual_pistol'
  | 'uzi' // GTA2 "Machine Gun"
  | 's_uzi'
  | 'silenced_s_uzi'
  | 'shotgun'
  | 'rocket'
  | 'flamethrower'
  | 'electrogun'
  | 'grenade'
  | 'molotov';

/** Events emitted by the simulation, consumed by audio/vfx layers. */
export type GameEvent =
  | { type: 'shot'; weapon: WeaponId; pos: Vec2 }
  | { type: 'hit'; pos: Vec2; surface?: 'ped' | 'car' | 'wall' }
  | { type: 'car_fire'; pos: Vec2 }
  | { type: 'molotov_smash'; pos: Vec2 }
  | { type: 'ped_on_fire'; pos: Vec2 }
  | { type: 'skid'; pos: Vec2; intensity: number }
  | { type: 'horn'; pos: Vec2 }
  | { type: 'busted'; pos: Vec2 }
  | { type: 'ped_killed'; pos: Vec2 }
  | { type: 'ped_scream'; pos: Vec2 }
  | { type: 'car_enter'; pos: Vec2 }
  | { type: 'car_exit'; pos: Vec2 }
  | { type: 'car_crash'; pos: Vec2; speed: number }
  | { type: 'explosion'; pos: Vec2 }
  | { type: 'pickup'; pos: Vec2 }
  | { type: 'player_died'; pos: Vec2 }
  /** player earned points — drives the big green world-space popups */
  | { type: 'score'; pos: Vec2; amount: number; label?: string };

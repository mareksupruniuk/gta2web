/**
 * Wanted-level ("heat") tracking with the original GTA2 numbers
 * (docs/gta2-reference.md §3, from the gta2_re decompilation):
 *
 *  - heat is 0..12000 points
 *  - star thresholds: 600 / 1600 / 3000 / 5000 / 8000 / 12000
 *  - kill ped +100, kill cop +500, destroy car +200 (but jumps to at least
 *    600 — one star — if below), jacking/ramming cops bumps to at least 600
 *  - NO passive decay: heat only resets on death, arrest, or respray
 */

export const HEAT_PER = {
  pedKilled: 100,
  copKilled: 500,
  carDestroyed: 200,
  copCarDestroyed: 500,
};

/** crimes that immediately guarantee at least one star */
export const HEAT_MIN_STAR = 600;

const LEVEL_THRESHOLDS = [600, 1600, 3000, 5000, 8000, 12000];
const HEAT_CAP = 12000;

export class Wanted {
  heat = 0;

  add(amount: number, minStar = false): void {
    this.heat = Math.min(HEAT_CAP, this.heat + amount);
    if (minStar && this.heat < HEAT_MIN_STAR) this.heat = HEAT_MIN_STAR;
  }

  update(_dt: number): void {
    // authentic: no passive cool-off
  }

  /** 0-6 cop heads. */
  get level(): number {
    let lvl = 0;
    for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
      if (this.heat >= LEVEL_THRESHOLDS[i]) lvl = i + 1;
    }
    return lvl;
  }

  clear(): void {
    this.heat = 0;
  }
}

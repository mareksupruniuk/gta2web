/**
 * Wanted-level ("heat") tracking, GTA2 style: crimes add heat, heat maps to
 * 0-6 cop heads, and it cools off slowly while the player behaves.
 *
 * PROVISIONAL constants — to be reconciled with docs/gta2-reference.md
 * (gta2_re research) when the exact values are confirmed.
 */

export const HEAT_PER = {
  pedKilled: 6,
  carDestroyed: 12,
  copKilled: 40,
  copCarDestroyed: 30,
  copHit: 3,
};

const LEVEL_THRESHOLDS = [0, 10, 30, 60, 100, 160, 240]; // heat → heads 0..6
const DECAY_PER_S = 1.2;
const DECAY_DELAY_S = 6; // no cooling right after a crime

export class Wanted {
  heat = 0;
  private sinceCrime = Infinity;

  add(amount: number): void {
    this.heat = Math.min(400, this.heat + amount);
    this.sinceCrime = 0;
  }

  update(dt: number): void {
    this.sinceCrime += dt;
    if (this.sinceCrime > DECAY_DELAY_S && this.heat > 0) {
      this.heat = Math.max(0, this.heat - DECAY_PER_S * dt);
    }
  }

  /** 0-6 cop heads. */
  get level(): number {
    let lvl = 0;
    for (let i = 1; i < LEVEL_THRESHOLDS.length; i++) {
      if (this.heat >= LEVEL_THRESHOLDS[i]) lvl = i;
    }
    return lvl;
  }

  clear(): void {
    this.heat = 0;
    this.sinceCrime = Infinity;
  }
}

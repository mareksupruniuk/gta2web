import { Vec2, dist } from '../sim/types';
import { GangDef } from './gangs';
import { Ped2 } from './ped2';
import { Car2 } from './car2';
import type { World2 } from './world2';

/**
 * GTA2 phone missions (modelled on the reference playthrough): each gang has
 * a ringing phone in its turf; answering it starts a job — a hit, a wreck,
 * or a timed delivery. JOB COMPLETE! pays out; failure puts the phone on
 * cooldown. One job at a time.
 */

export type MissionKind = 'hit' | 'wreck' | 'deliver';

export interface Phone {
  pos: Vec2;
  z: number;
  gang: GangDef;
  /** seconds until this phone rings again */
  cooldown: number;
}

export interface ActiveMission {
  kind: MissionKind;
  gang: GangDef;
  reward: number;
  /** current objective marker for HUD/renderer */
  target: Vec2;
  text: string;
  targetPed?: Ped2;
  targetCar?: Car2;
  deliverTo?: Vec2;
  timeLeft?: number;
}

const PHONE_COOLDOWN = 25;
const ANSWER_DIST = 0.6;

const INTROS: Record<MissionKind, (g: GangDef) => string> = {
  hit: (g) => `${g.name}: A rat needs silencing. Find him and waste him. Don't come back until he's cold.`,
  wreck: (g) => `${g.name}: Some punk parked where he shouldn't. Torch the car. Make it loud.`,
  deliver: (g) => `${g.name}: There's a motor waiting nearby. Get it to the drop, fast, and in one piece.`,
};

export class MissionManager {
  phones: Phone[] = [];
  active: ActiveMission | null = null;
  private ringTimer = 0;

  /** Build one phone per gang at the pavement spot nearest its turf centre. */
  init(world: World2): void {
    const seen = new Set<string>();
    for (const turf of world.turfs) {
      if (seen.has(turf.gang.id)) continue;
      const cx = turf.x + turf.w / 2;
      const cy = turf.y + turf.h / 2;
      const spot = world.pavementSpots()
        .filter((s) => s.x >= turf.x && s.x < turf.x + turf.w && s.y >= turf.y && s.y < turf.y + turf.h)
        .sort((a, b) => dist(a, { x: cx, y: cy }) - dist(b, { x: cx, y: cy }))[0];
      if (!spot) continue;
      seen.add(turf.gang.id);
      this.phones.push({ pos: { x: spot.x, y: spot.y }, z: spot.z, gang: turf.gang, cooldown: 0 });
    }
  }

  update(dt: number, world: World2): void {
    for (const ph of this.phones) ph.cooldown = Math.max(0, ph.cooldown - dt);

    const player = world.player;
    if (!this.active) {
      // audible ringing for nearby idle phones
      this.ringTimer -= dt;
      if (this.ringTimer <= 0) {
        this.ringTimer = 2.2;
        for (const ph of this.phones) {
          if (ph.cooldown === 0 && dist(ph.pos, player.pos) < 9) {
            world.emitEvent({ type: 'phone_ring', pos: { ...ph.pos } });
          }
        }
      }
      if (player.dead || player.car) return;
      for (const ph of this.phones) {
        if (ph.cooldown > 0) continue;
        if (Math.abs(ph.z - player.z) > 1 || dist(ph.pos, player.pos) > ANSWER_DIST) continue;
        this.start(ph, world);
        break;
      }
      return;
    }

    const m = this.active;
    if (player.dead) {
      this.fail(world);
      return;
    }
    if (m.timeLeft !== undefined) {
      m.timeLeft -= dt;
      if (m.timeLeft <= 0) {
        this.fail(world);
        return;
      }
    }

    switch (m.kind) {
      case 'hit':
        if (!m.targetPed || !world.peds.includes(m.targetPed)) return this.fail(world);
        m.target = m.targetPed.pos;
        if (m.targetPed.dead) this.complete(world);
        return;
      case 'wreck':
        if (!m.targetCar || !world.cars.includes(m.targetCar)) return this.fail(world);
        m.target = m.targetCar.pos;
        if (m.targetCar.exploded) this.complete(world);
        return;
      case 'deliver': {
        if (!m.targetCar || m.targetCar.exploded) return this.fail(world);
        m.target = player.car === m.targetCar ? m.deliverTo! : m.targetCar.pos;
        if (player.car === m.targetCar && dist(m.targetCar.pos, m.deliverTo!) < 1.6) {
          this.complete(world);
        }
        return;
      }
    }
  }

  private start(phone: Phone, world: World2): void {
    const kinds: MissionKind[] = ['hit', 'wreck', 'deliver'];
    const kind = kinds[world.rng.int(0, kinds.length)];
    const m: ActiveMission = {
      kind,
      gang: phone.gang,
      reward: kind === 'deliver' ? 3000 : kind === 'hit' ? 2000 : 1500,
      target: { ...phone.pos },
      text: INTROS[kind](phone.gang),
    };

    if (kind === 'hit') {
      const spot = world.spotAwayFromPlayer(12, 28, 'pavement');
      if (!spot) return;
      const ped = new Ped2({ x: spot.x, y: spot.y }, spot.z, 9); // distinctive remap
      world.peds.push(ped);
      world.protect(ped);
      m.targetPed = ped;
      m.target = ped.pos;
    } else if (kind === 'wreck') {
      const car = world.spawnMissionCar(12, 28);
      if (!car) return;
      m.targetCar = car;
      m.target = car.pos;
    } else {
      const car = world.spawnMissionCar(4, 10);
      const dropoff = world.spotAwayFromPlayer(22, 45, 'road');
      if (!car || !dropoff) return;
      m.targetCar = car;
      m.deliverTo = { x: dropoff.x, y: dropoff.y };
      m.target = car.pos;
      m.timeLeft = 100;
    }

    phone.cooldown = PHONE_COOLDOWN;
    this.active = m;
    world.emitEvent({ type: 'mission_start', pos: { ...phone.pos }, text: m.text });
  }

  private complete(world: World2): void {
    const m = this.active!;
    this.active = null;
    world.awardMission(m.reward, m.target);
    world.emitEvent({ type: 'mission_complete', pos: { ...world.player.pos } });
  }

  private fail(world: World2): void {
    this.active = null;
    world.emitEvent({ type: 'mission_failed', pos: { ...world.player.pos } });
  }
}

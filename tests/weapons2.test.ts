import { describe, expect, it } from 'vitest';
import { Inventory, WEAPONS } from '../src/game2/weapons2';

describe('Inventory', () => {
  it('starts with fists and infinite ammo', () => {
    const inv = new Inventory();
    expect(inv.current).toBe('fists');
    expect(inv.currentAmmo()).toBe(Infinity);
    expect(inv.has('fists')).toBe(true);
    expect(inv.has('pistol')).toBe(false);
    expect(inv.currentDef()).toBe(WEAPONS.fists);
  });

  it('add() grants ammo and switches to the added weapon', () => {
    const inv = new Inventory();
    inv.add('pistol', 24);
    expect(inv.current).toBe('pistol');
    expect(inv.currentAmmo()).toBe(24);
    inv.add('pistol', 24);
    expect(inv.currentAmmo()).toBe(48); // stacks
    inv.add('uzi', 60);
    expect(inv.current).toBe('uzi');
    expect(inv.ammo.get('pistol')).toBe(48); // pistol ammo kept
  });

  it('tryFire respects the cooldown and tick() clears it', () => {
    const inv = new Inventory();
    inv.add('pistol', 24);
    expect(inv.tryFire()).toBe(true);
    expect(inv.tryFire()).toBe(false); // still cooling down
    inv.tick(WEAPONS.pistol.fireInterval / 2);
    expect(inv.tryFire()).toBe(false);
    inv.tick(WEAPONS.pistol.fireInterval); // past the interval
    expect(inv.tryFire()).toBe(true);
  });

  it('firing decrements ammo (but never fists)', () => {
    const inv = new Inventory();
    inv.add('pistol', 5);
    expect(inv.tryFire()).toBe(true);
    expect(inv.currentAmmo()).toBe(4);

    const fists = new Inventory();
    expect(fists.tryFire()).toBe(true);
    expect(fists.currentAmmo()).toBe(Infinity);
  });

  it('removes the weapon at 0 ammo and falls back to fists', () => {
    const inv = new Inventory();
    inv.add('shotgun', 1);
    expect(inv.tryFire()).toBe(true); // last shell still fires
    expect(inv.current).toBe('fists');
    expect(inv.has('shotgun')).toBe(false);
    expect(inv.ammo.has('shotgun')).toBe(false);
    // empty weapon can no longer be fired even after the cooldown
    inv.tick(10);
    expect(inv.tryFire()).toBe(true); // this is the fists now
    expect(inv.current).toBe('fists');
  });

  it('cycle() cycles only through held weapons, in both directions', () => {
    const inv = new Inventory();
    inv.cycle(1);
    expect(inv.current).toBe('fists'); // only fists held

    inv.add('pistol', 10);
    inv.add('shotgun', 10); // current: shotgun; uzi NOT held
    expect(inv.current).toBe('shotgun');
    inv.cycle(1);
    expect(inv.current).toBe('fists'); // wraps, skipping uzi
    inv.cycle(1);
    expect(inv.current).toBe('pistol');
    inv.cycle(1);
    expect(inv.current).toBe('shotgun');
    inv.cycle(-1);
    expect(inv.current).toBe('pistol');
    inv.cycle(-1);
    expect(inv.current).toBe('fists');
    inv.cycle(-1);
    expect(inv.current).toBe('shotgun'); // wraps backwards
  });
});

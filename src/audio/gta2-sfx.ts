/**
 * GTA2 per-style SDT sound-bank ids (320 entries per style bank).
 *
 * Definitive id table extracted from the gta2_re decompilation
 * (CriminalRETeam/gta2_re, Source/sound_obj.cpp) — see
 * docs/gta2-reference.md SECTION 1 for the full table with confidence notes
 * and decomp line references. Comments below cite the same sources.
 *
 * These ids index into a `Gta2Bank` (src/audio/gta2bank.ts) parsed from the
 * district's `*.sdt` + `*.raw` pair (src/gta2/sdt.ts).
 */
export const SFX = {
  // --- Weapons (ProcessType7_Weapon_42A500, sound_obj.cpp:1879-1923) -------
  /** Pistol / dual pistol shot (sound_obj.cpp:1882). */
  SHOT_PISTOL: 311,
  /** Machine gun (SMG / car SMG / jeep gun) shot (sound_obj.cpp:1887). */
  SHOT_SMG: 312,
  /** Silenced SMG shot (sound_obj.cpp:1910). */
  SHOT_SILENCED_SMG: 313,
  /** Shotgun shot (sound_obj.cpp:1899). */
  SHOT_SHOTGUN: 314,
  /** Rocket launcher / tank gun fire (sound_obj.cpp:1892). */
  SHOT_ROCKET: 315,

  // --- Car sounds -----------------------------------------------------------
  /**
   * Player car engine rev samples 3-8 by vehicle class
   * (samp_idx_for_model_417AC0, sound_obj.cpp:2865-2945):
   * 3=default, 4=small cars, 5=sports, 6=sedans, 7=vans, 8=trucks/bus/tank.
   * Callers pass one of these to AudioManager.setEngineClass().
   */
  ENGINE_CLASS_MIN: 3,
  ENGINE_CLASS_MAX: 8,
  /** Car impact, light (Type_3_HandleCarImpactSound_4174C0, sound_obj.cpp:2799). */
  CAR_IMPACT_LIGHT: 12,
  /** Car impact, heavy (sound_obj.cpp:2789). */
  CAR_IMPACT_HEAVY: 13,
  /** Police/emergency siren loop (sub_417B80, sound_obj.cpp:2949-2965). */
  SIREN_LOOP: 14,
  /** Tyre skid loop (Type_10_HandleCarSkidSound_418940, sound_obj.cpp:3029). */
  SKID_LOOP: 22,
  /** Car door OPEN, normal cars (get_samp_idx_for_car_417D70, sound_obj.cpp:2822). */
  CAR_DOOR_OPEN: 25,
  /** Car door CLOSE, normal cars (same switch, `26 - (opening != 0)`). */
  CAR_DOOR_CLOSE: 26,

  // --- Explosion (decomp path is a stub; see doc "NOT FOUND" notes) ---------
  /**
   * Explosion: best acoustic candidate per docs/gta2-reference.md §1 —
   * long decaying noisy sample, 11025 Hz, 1.99 s. The decomp's explosion
   * audio path (ProcessOtherObjects_41F520) is NOT_IMPLEMENTED, so this is
   * an informed pick rather than a decomp-confirmed id.
   */
  EXPLOSION: 30,

  // --- Object impacts / glass (SelectObjectImpactSound_413120) --------------
  /** Small glass/light object break (Type6_4, sound_obj.cpp:5378). */
  GLASS_BREAK_SMALL: 40,
  /** Bigger glass/object break (Type6_4, sound_obj.cpp:5382). */
  GLASS_BREAK_BIG: 41,
  /** Car crash into object, normal: random of 43-45 (sound_obj.cpp:4801 `rnd%3+43`). */
  CRASH_CRUNCH_FIRST: 43,
  /** Car crash heavy (object flag 0x100): random of 46-48 (sound_obj.cpp:4797). */
  CRASH_CRUNCH_HEAVY_FIRST: 46,
  /** Number of crunch variants in each crash-crunch group. */
  CRASH_CRUNCH_COUNT: 3,
  /** Bullet hits car body: random of 62-64 (HandleCarWeaponHitSound_415480, :4155-4161). */
  BULLET_HIT_CAR_FIRST: 62,
  BULLET_HIT_CAR_COUNT: 3,

  // --- Ped sounds (ProcessPed_422B70, sound_obj.cpp:4442-4679) --------------
  /** Footsteps on pavement (block spec 1/3): random of 198-201 (sound_obj.cpp:4495). */
  FOOTSTEP_FIRST: 198,
  FOOTSTEP_COUNT: 4,
  /** Random ped chatter/mumble: random of 233-238 (sound_obj.cpp:4576 `rnd%6+233`). */
  PED_CHATTER_FIRST: 233,
  PED_CHATTER_COUNT: 6,
} as const;

# GTA2 Reference (from gta2_re decompilation)

Research notes for the web remake, extracted from the GTA2 decompilation at
https://github.com/CriminalRETeam/gta2_re (clone at `/tmp/gta2re`,
commit `1170475410762eccf32e54ce84fc265d13d01db1`, 2026-06-09).

All `file:line` references are into the gta2_re `Source/` directory unless
stated otherwise. Game fixed-point convention: positions are 16.16 fixed point
(`Fix16`), 1 tile = 1.0 = 65536 raw; speeds are usually per-frame at 30 FPS.

Sections:
1. Sound IDs (per-style SDT bank)
2. Ped animation frame table
3. Police / wanted system
4. Traffic generation
5. Ped generation
6. Car deltas (damage states)
7. Car handling / collision dimensions
8. Player constants

---

## 1. Sound IDs (per-style SDT bank, 320 entries)

Source: `Source/sound_obj.cpp` / `sound_obj.hpp`. The engine stores the bank
sample id in `sound_0x68::field_14_samp_idx`; **321 is the "no sample"
sentinel** (`sound_obj.cpp:153`, `:719`, `:872`), confirming the bank has
indices 0..320 — matching the 320 entries our `src/gta2/sdt.ts` parses (+1).

Sound entity types (`infallible_turing.hpp:5-21`): 1=Sprite (ped/car/object),
2=ambience, 3=cop radio/music, 6=one-shot FX pool (Rozza), 7=weapon, 8=crane,
9=crusher, 10=vocals, 11=HUD pager.

### Weapons (ProcessType7_Weapon_42A500, sound_obj.cpp:1879-1923)

| idx | name | confidence |
|----:|------|------------|
| 311 | pistol / dual pistol shot | HIGH (sound_obj.cpp:1882) |
| 312 | machine gun (SMG / car SMG / jeep gun) shot | HIGH (:1887, vol 44) |
| 313 | silenced SMG shot | HIGH (:1910) |
| 314 | shotgun shot | HIGH (:1899, vol 44, rate −8000) |
| 315 | rocket launcher / tank gun fire | HIGH (:1892) |
| 316 | flamethrower (loop-ish, vol 120) | HIGH (:1905) |
| 317 | fire-truck water cannon | HIGH (:1922) |
| 318 | electrogun ("shocker") | HIGH (:1895) |
| 319 | car bomb / mine deploy click | HIGH (:1916) |
| 61  | oil slick deploy | HIGH (:1919) |

All weapon shots: emit volume 40 (44 for SMG/shotgun), one-shot type 20,
falloff `field_54 = 163840` (2.5 tiles), max_distance 20, random rate
displacement (sound_obj.cpp:1948-1960).

### Car sounds

| idx | name | confidence |
|----:|------|------------|
| 1, 2 | car-driving-on-water splash loop (model parity picks 1 or 2) | HIGH (UpdateCarSurfaceAudio_418610, sound_obj.cpp:5649-5655; triggers when `Car_BC::field_9C == 4`) |
| 3–8 | player car engine rev samples by vehicle class: 3=default, 4=small cars (BUG/DART/FIAT/ISETTA/MESSER/MORRIS/STYPECAB), 5=sports (MIURA/STRATOS/SPIDER/XK120/...), 6=sedans incl. COPCAR/EDSELFBI/TBIRD, 7=vans (VAN/PICKUP/SWATVAN/ICECREAM/VESPA), 8=trucks/bus/tank (BUS/FIRETRUK/GTRUCK/TANK/APC) | HIGH (samp_idx_for_model_417AC0, sound_obj.cpp:2865-2945; used by Type_1_6_416260 :2748) |
| 9 | player engine alt sample (Type_1_6 branch) | MED (sound_obj.cpp:2752) |
| 12 | car impact, light | HIGH (Type_3_HandleCarImpactSound_4174C0, sound_obj.cpp:2799,2811) |
| 13 | car impact, heavy | HIGH (sound_obj.cpp:2789,2805) |
| 14 | police/emergency SIREN loop (also fire truck siren) | HIGH (sub_417B80, sound_obj.cpp:2949-2965: FIRETRUK→14, else horn-off→14) |
| 15 | siren fast/alternate loop (cop car with horn held — horn toggles siren tone) | HIGH (sub_417B80: bHornOn→15; init by Type_4_417A00 :2977; activation gate HandleSirenActivationSound_4178C0 :4222 — only when `info_flags bit2 or FBI car` && `field_A4 & 4` && engine state 3 && has driver) |
| 16–20, 23 | AI/dummy car engine loops by audio class: 16=default, 17=small cars, 18=sports/fast, 19=trucks/bus/tank, 20=train cab, 23=ice-cream van (jingle engine) | HIGH (GetVehicleAudioClass_417BA0, sound_obj.cpp:3528-3586; used by Type_5_InitEngineSoundProfile_415730 :3003; per-model playback rates in ConvertToPlayBackRate_417C60 :1116-1186) |
| 21 | player engine special (Type_1_6 branch) | MED (sound_obj.cpp:2758) |
| 22 | tyre skid loop | HIGH (Type_10_HandleCarSkidSound_418940, sound_obj.cpp:3029; rate varies 12600-18000 by surface `field_9C`) |
| 24 | AI-car engine hum loop (sound type 8 = HandleAICarEngineSound) | HIGH (Type_8_418130, sound_obj.cpp:1069) |
| 25 | car door OPEN (normal cars) | HIGH (get_samp_idx_for_car_417D70, sound_obj.cpp:2822-2862: `26 - (opening!=0)`) |
| 26 | car door CLOSE (normal cars) | HIGH (same) |
| 27 | truck/tank/APC/firetruck door open | HIGH (same: `28 - (opening!=0)`) |
| 28 | truck door close | HIGH (same) |
| 29 | bus/train door (hiss); ALSO heavy-vehicle air-brake stop (sound type 7) | HIGH (sound_obj.cpp:2854 and Type_7_417EF0 :1105; heavy = car models 3,7,11,17,21,58,63,64,86 per IsHeavyTruckOrBus_417F40 :1080) |
| 31 | door sound for cars with extreme remap (train/bus special case) | MED (sound_obj.cpp:2831) |
| 35 | tank turret rotate loop (sound type 12) | MED (Type_12_414C90, sound_obj.cpp:3138, queued from Tank_414A50) |
| 36 | car alarm loop (sound type 13, set from HandleCarAlarmSound_415570 :3832) | HIGH (Type_13_4153F0, sound_obj.cpp:1189) |
| 57 | HUD pager beep; also Type_15 (car burning init, see below) | HIGH (ProcessType11_HudPager_418B60, sound_obj.cpp:2412; Type_15_415100 :3151) |
| 60 | crane motor / crusher / heavy machinery loop (also sound type 11 via Tank_414D30) | HIGH (ProcessType8_Crane :2045-2069, ProcessType9_Crusher :2159, Type_11_414EE0 :3125) |
| 62 | bullet hits car body (variant 1) | HIGH (HandleCarWeaponHitSound_415480, sound_obj.cpp:4155; weapon-type switch) |
| 63 | bullet hits car body (variant 2) | HIGH (:4158) |
| 64 | bullet hits car body (variant 3) | HIGH (:4161) |
| 65 | special weapon hit on car (variant) | MED (:4152) |
| 66 | flame/water-jet hit on car | MED (:4149) |
| 67 | flame/water-jet hit on car (variant) | MED (:4145) |
| 139 | train cab brake screech/station stop | MED (TrainCab_414710, sound_obj.cpp:5107) |

Car damage rattle: sound type 6 = HandleCarDamageSound_4177D0 (sound_obj.cpp:3880-3903)
plays when `field_74_damage > 16000`, volume scales with damage; sample id is
slot-based (SampleIndex 1) — actual bank sample resolved via Type_1_6.

### Object impacts / glass / surfaces (SelectObjectImpactSound_413120, sound_obj.cpp:4755-4990; Type6_* one-shot pool)

| idx | name | confidence |
|----:|------|------------|
| 33 | impact: model 295 / heavy object | MED (:4826, :4866 region) |
| 34 | impact: model 266 / metal object | MED (:4817, :4915 region) |
| 37 | generic soft thud / object impact default (rate 20000±2000) | HIGH (:4779, :4933, Type6_2 a<40 :5208, Type6_5 :5399) |
| 38 | medium impact (Type6_2/5 intensity 40-89; Type6_12 splash spec 2/10) | HIGH (:5212, :5403, :5181) |
| 39 | hard impact (intensity ≥90; Type6_12 spec 1/3/5-9) | HIGH (:5216, :5407, :5177) |
| 40 | small glass/light object break (intensity 15-22, Type6_4) | MED (:5378) |
| 41 | bigger glass/object break (intensity ≥23, Type6_4) | MED (:5382) |
| 42 | car scraping object (interactionType 7 on car models 192/254/265) | HIGH (:4808) |
| 43–45 | CAR CRASH into object, normal (random of 3) | HIGH (:4801 `rnd%3+43`, models 192/254/265 = car bodies, interactionType 3) |
| 46–48 | CAR CRASH heavy (object flag 0x100) | HIGH (:4797 `rnd%3+46`) |
| 49–51 | car/object crash other interaction (random of 3) | HIGH (:4812 `rnd%3+49`) |
| 52 | impact small metal (model 6, rate 16000±600) | MED (:4881) |
| 53 | impact wood/crate (models 12/14/58, 21/22/46/48) | MED (:4894-4915) |
| 54 | impact metal bin (models 4/23/44, rate 17000±2000) | MED (:4871) |
| 55 | impact light pole/sign (models 1/18, 7, 16/25/62) | MED (:4846-4904) |
| 56 | impact heavy pole (models 3/5/11/13/17/53-55) | MED (:4866) |
| 68 | WATER SPLASH (object/ped into water; block spec 4; rate 28000±4000) | HIGH (:4955, :5167) |

### Ped sounds (ProcessPed_422B70, sound_obj.cpp:4442-4679)

| idx | name | confidence |
|----:|------|------------|
| 58 | electrocution scream/zap loop | HIGH (:4602, ped_state_2::electrocuted_27) |
| 193 | FALLING SCREAM (ped falling from height; rate scales with z) | HIGH (:4670; triggered when zpos > threshold) |
| 194–197 | footsteps, block spec 5/6/8/9 (random of 4: `v6..v6+3`) | HIGH (:4504, :4529) |
| 198–201 | footsteps, block spec 1/3 (pavement?) | HIGH (:4495) |
| 202–205 | footsteps, block spec 2/10 (road?) | HIGH (:4499) |
| 206–209 | footsteps, block spec 7 (metal?) | HIGH (:4507) |
| 233–238 | random ped chatter/mumble (random of 6, every 20-49 ticks) | HIGH (:4576 `rnd%6+233`, timer reset :4598 `rnd%30+20`) |

Footsteps trigger on animation frames 1 and 5 of walk/run anims (:4485),
walking = emit vol 5, running (anim state != 0) = vol 20 (:4514-4522).

### Ambience / misc

| idx | name | confidence |
|----:|------|------------|
| 0 | looping ambience (sound type 2 — engine idle Type_2_4182A0 sound_obj.cpp:1056) | MED |
| 2/3 | zone ambience stereo pair (ProcessType2_412490 sound_obj.cpp:2489-2492; pairs 0/1..16/17 exist in a switch but only type-2 case is live) | MED |

### NOT FOUND in gta2_re

- **Explosion**: explosions are map objects; their audio runs through
  `ProcessOtherObjects_41F520` which is `STUB_FUNC`/NOT_IMPLEMENTED
  (sound_obj.cpp:4437-4441), and `ProcessObject_Type12_41E850` is also a stub
  (:4397). Best candidates by acoustics (gamedata/audio/INDEX.md): the
  20000 Hz percussive cluster 43-51 is car-crash, so explosion is most likely
  idx 30 (long decaying noisy, 11025 Hz, 1.99 s) or one of 10/11 (long
  sustained low rumbles). Needs listening test.
- **Punch/fist hit on ped, ped death scream, pickup/collect**: ped voice
  events go through `HandlePedVoiceEvent_423080` which is a stub
  (sound_obj.cpp:4216-4220). Pickup/collect sound not referenced anywhere in
  the decomp sources (searched: pickup/powerup/collect across Source/).
- Note `Type6_Play_412D90` (sound_obj.cpp:5498-5620) maps object models
  64-108/200-244 to samples 27-54 of the **vocal stream bank**
  (`PlayVocal_58E510`), NOT the SDT effects bank — don't confuse the two.

## 2. Ped animation frame table

Source: `Char_B4::UpdateAnimState_546360` (`Source/char.cpp:618-1645`). The
sprite id is computed as `baseId + animOffset + frame`, where `baseId` depends
on `Ped::field_26C_graphic_type` (char.cpp:655-668):

| graphic_type | baseId | meaning |
|---|---|---|
| 0 | 0 | standard ped sprite set |
| 1 (default) | 158 | second ped set |
| 2 | 316 | third set — used for army drivers of APC/JEEP/TANK, remap 4 (char.cpp:1512-1518) |

So 474 ped sprites = 3 sets x 158 sprites; all offsets below are within a set
(0-157).

Anim states (`Char_Anim_state`, enums.hpp:498-518; death states inferred from
`state_8_5520A0` char.cpp:5108+ and `state_9_552E90` char.cpp:5605-5648):

| anim state | sprite offsets | frames | frame timer (game ticks/frame) | meaning |
|---|---|---|---|---|
| 0 walk | 0-7 unarmed; 37-44 armed (+37 if weapon selected, char.cpp:758-768); 143-148 if `char_state==0` | 8 (6 for the 143 branch) | advance when timer > 2 (char.cpp:749-757) | WALK; 143-148 is a slow/idle-walk variant |
| 1 run | 8-15 unarmed; 45-52 armed (+37); 135-140 if `char_state==0` | 8 (6) | timer > 1 (char.cpp:781-799) | RUN (armed run = 45-52) |
| 2 idle | 53-56 idle (4 frames, timer > 8); 57-64 smoking (offset 53+4, 8 frames; cigarette puff at frame 5, char.cpp:817-859) | 4 / 8 | 8 | IDLE / smoking idle |
| 3 / firing | 139 (single frame) | 1 | - | shooting stance (reached when attack flag 0x800 set, char.cpp:861-864) |
| 4 attack | 115-122 standing (vel <= k_dword_6FD7C0); 123-130 moving | 8 | timer > 2 (char.cpp:866-895) | PUNCH / grenade-molotov THROW (same anim, char.cpp:705,740,2595) |
| 5 jump | 16-23 (frame 8 lands on 23, scale effect applied frames 6-7) | 9 | 2-3 (player field_71=2, NPC=1) (char.cpp:897-1010) | JUMP |
| 6 / 9 enter car | 24-27 (reach/open door, frames 0-3), 28-31 (climb in, sub-case `+28` frames 4-7 and `+19` frames 9-12) | 12 | varies 1-5 | ENTER CAR; frame 8 switches ped to in_car (char.cpp:1395-1505) |
| 7 exit car | reverse: 33-36 (and 24-31 mirrored), pulled-driver spawn at inner frame 9 (char.cpp:1019-1140, 1503+) | ~8 | 3 | EXIT CAR / pull driver out |
| 8 pulled out | ends at 36 (char.cpp:1212-1265); set by ped_state_2 17 (char.cpp:5240-5244) | ~3 | - | being yanked from car |
| 10 / 13 lying | 72 (single) | 1 | - | LYING ON FLOOR (ped_state_2::lying_on_floor_22 default, char.cpp:5169-5170) |
| 11 fall | 81-94 (frames 0-13) | 14 | - | NORMAL FALL (ped_state_2::falling_19, char.cpp:5176-5177) |
| 12 lethal fall | 81-97 (continues frames 14-16 -> sprites 95-97) | 17 | - | LETHAL FALL / crushed-attached (Unknown_24/25/26, char.cpp:5211-5224) |
| 14 corpse A | 80 (single) | 1 | - | dead pose (random pick, char.cpp:5635-5638) |
| 15 die A | 65-72 (8 frames) | - | - | DEATH anim variant A (`char_state 33`, char.cpp:5155-5158, 5613-5618) |
| 16 die B | 73-80 (8 frames, sprite rotated 180 deg: `field_40_rotation += word_6FD936`) | - | - | DEATH anim variant B (`char_state 34`) |
| 17 electrocuted | 151-154 (4 frames) | - | - | ELECTROCUTION jitter (ped_state_2::electrocuted_27, char.cpp:5246-5249) |
| 18 | none | - | - | initial/hidden state (char.cpp:210, 280) |
| 19 corpse B | 156 (single) | 1 | - | dead pose |
| 20 corpse C | 157 (single) | 1 | - | dead pose |
| 21 burned corpse | 155 (single) | 1 | - | CHARRED corpse — set in `Ped::Kill_46F9D0` when `k_ped_in_flames` (Ped.cpp:8864-8870) and after electrocution death (char.cpp:5556-5563) |

Notes:
- There is no separate per-weapon stance: armed walk/run is one offset (+37)
  regardless of weapon type.
- No swim animation: peds in water get ped_state_2::sinking_20 -> anim state 2
  for 10 ticks then drown (char.cpp:5205-5208).
- Burning-alive peds keep their run animation; fire is a particle overlay
  (Kill switches to 21 only at death).
- Unassigned ranges (98-114, 131-134, 141-142, 149-150) are not referenced by
  UpdateAnimState — likely unused/extra frames per set.

## 3. Police / wanted system

### Wanted points and star levels

Heat is a 0..12000 point score per ped (`Ped::field_20A_wanted_points`):

- Star thresholds (`cop_level_ped_enum`, enums.hpp:189-199, and
  `Ped::get_wanted_star_count_46EF00`, Ped.cpp:8287-8333):
  1*=600, 2*=1600, 3*=3000, 4*=5000, 5*=8000, 6*=12000.
- `Ped::add_wanted_points_470160` clamps to [0,12000] (Ped.cpp:9251-9267).

Heat per crime (all via add_wanted_points or direct set):

| crime | points | ref |
|---|---|---|
| kill gang member | +1 | Ped.cpp:8748 |
| kill cop / emergency-services ped | +500 | Ped.cpp:8752 (`threat_reaction == react_as_emergency_1`) |
| kill normal ped | +100 | Ped.cpp:8756 |
| destroy a car (driver kill credit) | +200, but min 600 (jump to 1 star if below) | Car_BC.cpp:3269-3276, 3488-3494 |
| jack a cop out of a cop car | min 600 (set if below) + registered as active criminal | char.cpp:1546-1552 |
| run over cop / hit cop car (player driving) | min 600 | CarPhysics_B0.cpp:2651-2653, 2727-2729 |

Decay/reset: no gradual decay found. Heat resets to 0 on: respray at spray
shop (Car_BC.cpp:5904 in the pay-for-respray path), death/arrest respawn
(Player.cpp:1904, 1964-1977), and when ped becomes "empty" occupation
(Ped.cpp:3665-3676). `field_660_wanted_star_count` = max attainable stars
(6 in single player, 1 in network; Police_7B8.cpp:72-79).

### Force escalation

`Police_7B8::field_654_wanted_level` (0-6, the star count of the worst
criminal) and `field_65C` = force type: 3 = police, 4 = FBI, 6 = army
(Police_7B8.cpp:70 inits 3). The per-frame dispatcher that raises
field_654/field_65C is `sub_56FBD0` — **STUB / NOT_IMPLEMENTED**
(Police_7B8.cpp:425-429), so the exact level->force table is not in the decomp
(GTA2 manual behavior: 1-3 stars police, 4 SWAT, 5 FBI, 6 army).

What IS in the decomp:

- Cop cars spawn through the traffic spawner: at wanted >= 1, each traffic
  spawn has a 9-in-40 (22.5%) chance (`rng(40) in 21..29`) of forcing a police
  vehicle instead of a civilian model (Car_BC.cpp:7024-7037).
- Police vehicle by force type (Car_BC.cpp:7050-7066):
  force 3 -> COPCAR (model 12), force 4 -> EDSELFBI (model 84),
  force 6 -> GUNJEEP (model 22).
- Army mode (force 6) also replaces civilian traffic with: APC (model 3) 40%,
  TANK (model 54) 30%, JEEP (model 30) 30% (`rng(10)`: 0-3/4-6/else,
  Car_BC.cpp:7068-7086).
- Simultaneous police crews capped by `field_658_count >= field_659`
  (Car_BC.cpp:7044); field_659 initialized to 1 (Police_7B8.cpp:69) and bumped
  by the stubbed dispatcher. FBI/army hard caps: max 30 FBI/army peds
  (`field_5_fbi_army_count >= 30`, Police_7B8.cpp:514-517), max 3 crews
  (`field_658_count > 2`, :518-521).

### Crew composition (per car)

| unit | spawn fn | count | health | weapons | remap/graphic |
|---|---|---|---|---|---|
| cops in car | SpawnPoliceInCar_570BF0 (Police_38.cpp:139-222) | 2 | 50 (wanted 0-1) / 100 (2+) | pistol | remap 0, graphic_type 2 |
| SWAT | SpawnSWAT_570E30 (Police_38.cpp:222-269) | 4 | 400 each | pistol | remap -1, graphic_type 2, occupation swat |
| FBI | FBI_Army_5703E0 case 4 (Police_7B8.cpp:556-573) | 2 | 250 | leader: shotgun + silenced SMG; both silenced SMG | remap 8, graphic_type 1 |
| army | FBI_Army_5703E0 default (Police_7B8.cpp:625-639) | 2 | 250 | SMG | remap 4, graphic_type 2 |
| roadblock guard | SpawnRoadblockGuard_56F5C0 (Police_7B8.cpp:141-179) | per call | 200 | type 3: silenced SMG (remap 8, graphic 1); type 1: pistol (remap 0, graphic 2) | guards stand `guard_spot` objective |
| walking cop guard | SpawnWalkingGuard_570320 (Police_7B8.cpp:479-510) | 1 | - | - | army variant if force 6 (remap 4) |

### Behavior states

`police_crew_state` (Police_38.hpp:13-22): `patrol_1`, `2` (despawn/return),
`alerted_search_3`, `pursue_or_chase_5`, `shutdown_6`. State machine in
`PoliceCrew_38::Service_575590` (Police_38.cpp:792-841). The chase logic
`sub_572920` is a STUB (Police_38.cpp:584). When a crew is switched to chase,
`sub_5707B0` sets state 5 and calls `ActivateEmergencyLights_43C920` —
i.e. SIREN/LIGHTS ON exactly when a crew enters pursue state
(Police_7B8.cpp:706-714). Cop cars are identified by
`Car_BC::IsPoliceCar` = model in {COPCAR 12, SWATVAN 52, EDSELFBI 84}
(Car_BC.cpp:1298-1299).

Criminal tracking: up to 4 active criminals (`field_464[4]`, one per player).
Each record keeps last-seen x/y/z and a 250-tick "last seen" countdown
(`field_C = 250`, refreshed on sighting, Police_7B8.cpp:719-731; decremented
in sub_56FA40 :390-410 — when it hits 0 during chase the record drops to
search mode `field_8 = 5`).

Roadblocks: only at wanted >= 3, with a 40-tick cooldown between attempts
(`sub_577320`, Police_7B8.cpp:750-758). A roadblock = up to 6 cars + 12
barriers + 6 guards (PoliceRoadblock_A4 fields, Police_38.cpp:850-895).
Placement fn `TryCreateRoadblockAt_577370` is a STUB. During roadblock
creation the traffic spawner forces model bank_van (4) for the blocking
vehicle (Car_BC.cpp:7040-7043).

Arrest: `SetArrestedPed_56F8E0` called from Player.cpp:1898 (busted handling);
script opcode CHAR_ARRESTED exists (miss2_0x11C.cpp:5715). The on-foot
arresting cop behavior is in stubbed ped objective code — NOT FOUND in detail.
"At which star do cops shoot": not directly recoverable (dispatcher stub);
indirect evidence: cop health/weapon loadout changes at wanted 2 (above), and
at wanted 6 even emergency peds switch objective (Ped.cpp:2764-2770).

Side effects: dummy-ped spawn budget is HALVED when wanted level > 3
(PedManager::Dummies_470330, Char_Pool.cpp:1060-1065); civilian traffic factor
shrinks with wanted level (see section 4).

## 4. Traffic generation

Driver: `Car_14::GenerateTraffic_583670` (Car_BC.cpp:6663-6707), per player
camera per frame -> `MakeTrafficForCurrCamera_5832C0` (:6541-6645) ->
`SpawnTrafficCar_582480` (:6745+).

Limits and distances (all Fix16, 1.0 = 1 tile = 65536):

| constant | value | meaning |
|---|---|---|
| max traffic cars | 16 | `field_28_recycled_cars + field_40_proto_recycled_cars != 16` (Car_BC.cpp:6549-6550, 6848); some allocs require < 15 (:1029) |
| spawn margin (ahead of edge) | 0x14000 = 1.25 tiles | dword_6FF6D4 (Car_BC.cpp:110), added outside the camera boundary rect on the chosen side (:6884-6940) |
| lateral scan margin | 0x10000 = 1.0 tile | dword_6FF778 (:97) |
| scan step along edge | 0x8000 = 0.5 tile | dword_6FF77C (:108) |
| car half-extent pad for clear-check | x 0x6000 = 0.375 | dword_6FF680 (:109), multiplies CARI w/h when testing spawn rect |
| map bound for spawn | 0x3FC000 = 63.75 tiles | dword_6FF558 (:92) |
| despawn (civilian) | unseen for >= 130 ticks | `field_76_last_seen_timer >= 130` (Car_BC.cpp:5118-5126), timer++ while not on any screen with margin 0x14000 (dword_6778D0, :88), reset to 0 when seen |
| despawn (cop/fire/swat/tank/gunjeep/FBI) | unseen for exactly 300 ticks | same place, `== 300` |

Traffic budget scales with camera area and wanted level
(MakeTrafficForCurrCamera, Car_BC.cpp:6553-6585):
`budget = (cam_w * cam_h / 86) * factor`, factor by wanted level:
0-1 -> 1.0 (0x10000), 2 & 5 -> 0.2 (0x3333), 3 -> 0.15 (0x2666),
4 & 6 -> 0.1 (0x1999). Spawn direction (N/S/E/W edge) picked by rng(5)
with fallbacks through all four (:6588-6643).

Spawn-tile requirements (SpawnTrafficCar, Car_BC.cpp:6973-7012): block must
exist, must be road (`slope_type & 3 == 1`), not a sloped block, every tile
under the car rect must match the green-arrow direction
(`EveryTileMatchesArrowType_59DFB0`), spawn rect free of collisions, not
visible to any player, zone car_density != 0.

Model selection (`Car_6C::SelectTrafficCarModel_444AB0`, Car_BC.cpp:340-446):

- Density gate: `chance = clamp(25 * budget * zone_car_density/250, 0, 99)`;
  spawn proceeds only if player rng `field_680 >= 100 - chance` (:343-364).
- Zone ratios (per nav zone): goodcar/badcar/policecar/gangcar ratios;
  defaults when no zone: good 300, bad 300, police 100, gang 0 (:369-383).
  A value from a 1000-entry rng remap table is compared cumulatively:
  `< good` -> good list, `< good+bad` -> bad list, `< +police` -> COPCAR
  (model 12, class 4), `< +gang` -> gang car (model picked later, class 5),
  else -> "average" list (class 3).
- Lists are built by `DistributeCarsByRating_444980` (Car_BC.cpp:279-336)
  from CARI: model must be in the STY RECY block
  (`IsCarModelInRecycleList_5AB380`), rating 99 = never in traffic;
  rating 1-9 -> BAD list, 11-19 -> AVERAGE list, 21-29 -> GOOD list, with
  `rating % 10` weighted copies of the model in its list.
  NOTE: the decomp maps the *good zone ratio* to list dword_677384 which is
  filled from ratings 21-29 — i.e. rating 2x = good, 1x = average, 0x = bad,
  matching the GTA2 style docs.

Cruise speed (`Car_14::sub_583750`, Car_BC.cpp:6709-6743), derived from the
model's max speed (ModelPhysics), randomized per spawn:

| model max_speed | cruise speed range (tiles/tick, 16.16) |
|---|---|
| >= 0x1333 (0.075) | 0x1333 + rnd(100)/25 * (0x1999-0x1333) (0.075-0.1 band) |
| >= 0xCCC (0.05) | 0xCCC + rnd(100)/25 * (0x1333-0xCCC) (0.05-0.075 band) |
| else | 0x1EB (0.0075) + rnd(100)/25 * (0xCCC-0x1EB) |

Wanted-level interactions: at wanted >= 1 there is a 22.5% chance the spawn
becomes a police vehicle; at wanted >= 3 a pending roadblock converts the
spawn to a bank_van blocker (see section 3). Spawned cars on rails (TRAIN/
TRAINCAB/TRAINFB/boxcar) use `GetRailwayZCoordAtXY` (Car_BC.cpp:7407-7411).


---

## 5. Ped generation (dummy peds)

Sources: `Char_Pool.cpp` (PedManager), `Ped.cpp` (constants + per-tick
counting), `Camera.cpp`.

Fixed-point note (correction to the header of this doc): `Fix16` is **18.14**,
i.e. `1.0 tile = 0x4000 = 16384` raw; `ToInt()` is `>> 14` and the float ctor
multiplies by 16384.0 (fix16.hpp:164-167, 227-231). Raw hex constants quoted
in earlier sections should be divided by 16384, not 65536 (the *ratios* /
band logic there are unaffected).

### Population cap

- `PedManager::field_0 = 50` — max dummy peds (PedManager ctor,
  Char_Pool.cpp:732).
- `PedManager::Dummies_470330` (Char_Pool.cpp:1057-1090): if
  `wanted_level > 3` the cap is **halved to 25** (`v1 >> 1`, :1062-1065).
- Current count `byte_6787E2` is rebuilt every tick in the per-ped update
  (Ped.cpp:3579-3596): counts peds with `field_238 == 3` (dummy state) and
  peds in state 4/6 whose threat reaction is not emergency. Emergency
  (cop-type) peds count into `byte_6787E4` instead, state-5 into
  `byte_6787E3` — i.e. cops/medics don't eat the 50-ped budget.

### Spawn rate & placement vs camera (`SpawnDummies_46EB60`, Char_Pool.cpp:450-629)

Runs once per player camera per tick (only while count < cap):

- Camera target speed check `pCam->sub_435A20() > k_dword_678438` where
  `k_dword_678438 = Fix16(0)` (Ped.cpp:66-67; Camera.cpp:278-295 returns
  ped/car velocity) — i.e. **any movement at all**:
  - moving: spawn side is locked to the side the target faces
    (`ComputeTargetFacingAngle_4358D0`, Camera.cpp:227-275; flipped to the
    rear angle `+word_676772` when reversing), `spawnCountLimit = 1`
    attempt/tick (decomp note says the original constant is **3**,
    Char_Pool.cpp:1075-1080).
  - stationary: `spawnCountLimit = 2` attempts/tick, cycling round all 4
    sides via `gSpawnSide_6787C8` / `gSpawnIndex_6787C9` walking 1 tile per
    attempt along the current edge, advancing to the next side when the edge
    is exhausted (Char_Pool.cpp:523-590, 619-625).
- Spawn band: the camera's non-negative view rect expanded by
  `k_dword_67853C = 0x2000 = 0.5 tile` on every side (Ped.cpp:83,
  Char_Pool.cpp:473-476) — peds appear on a perimeter ~0.5 tile outside the
  visible screen edge.
- Inward jitter: `gSpawnJitterScale_678618 = 256 raw (1/64 tile)` times
  `rnd(32)+8` added to both x and y → 0.125 .. 0.609 tile (Ped.cpp:91,
  Char_Pool.cpp:592-593).
- Map-border clamp: position must be more than `k_dword_678664 = 0x4000 =
  1 tile` from the 0/255 map edges (Ped.cpp:80, Char_Pool.cpp:595-596,
  `dword_678414 = 255` Char_Pool.cpp:44).
- Zone density gate: spawn only if
  `field_6_num_peds_on_screen < zone.ped_density / 25` (Char_Pool.cpp:598-599)
  — ped_density is the per-nav-zone 0..100 value, so max 4 on-screen peds at
  density 100. On-screen count `gNumPedsOnScreen_6787EC` is incremented in
  the ped update (Ped.cpp:3229, 3301).
- Block checks: must find a pavement block at the coord
  (`FindPavementBlockForCoord_4E4BB0`, Char_Pool.cpp:601), probe sprite of
  size `gDummyW/H = 0xCCC (0.2 tile)`, z-extent `0x1000 (0.25)`
  (Ped.cpp:92-96, Char_Pool.cpp:603-605), point must NOT be on screen
  (`is_point_on_screen_4B9A80`, :606), and block above must not have
  `slope_type & 0xFC` in `[0xB4, 0xD0]` (:608-613).
- Facing: spawned facing along the edge they appear on —
  left=360, top=0, right=1080, bottom=720 (Ang16, 0..3600 = 360 deg;
  Char_Pool.cpp:66-69, 558-590).

### Occupation probabilities (`SpawnPedestrianAt_46E380`, Char_Pool.cpp:77-447)

One rng draw `rnd(1000)` compared cumulatively against the nav-zone ratios
(`gmp_zone_info` fields, Char_Pool.cpp:105-153):

| cumulative band (out of 1000) | kind | notes |
|---|---|---|
| `< mugger_ratio` | mugger | max **1 alive** (`gNumberMuggersSpawned`), remap 17, occupation `mugger`, objective timer 40 (:179-193) |
| `< + carthief_ratio` | car thief | max 1 alive, remap 15, `field_1F8_run_speed = Fix16(4)` (:195-214) |
| `< + elvis_ratio` | elvis chain | only a further **1-in-50** roll (`rnd(50)==25`) actually spawns; spawns leader + 5 followers via `SpawnPedChainGroupAt_46DB90`, remap 12, max 1 group (:126-137, 216-224, 1098-1142) |
| `< + gangchar_ratio` | gang ped | global gang-ped cap 8 (`byte_6787CE`); first 4 are `armed_gang_member_19` with the gang's current weapon + pistol, rest are dummy-state peds in gang remap; remap comes from `Gang_144::field_101` (5 has a 50% alt of 6) (:139-143, 226-311) |
| `< + policeped_ratio` | walking cop | max 1 alive; health **50** + pistol at wanted 0-1, health **100** + pistol at wanted 2; speed `field_1F0 = dword_678448 * dword_6784A0 = 0.0625 * 0.8 = 0.05 tiles/tick` (:314-352) |
| else | plain dummy | remap: `rnd(25)` → `<4` gives 18-21, else +27 gives 31-51 (:354-390) |

Spawn is aborted (ped deallocated) if it lands on another sprite
(`FindNearestSpriteOfType_477E60`, :401-408). `gSpawnCounter_6787C6` wraps at
200 (:443-446). Debug `make_all_muggers` converts 50% of spawns to
`mad_mugger_40` (:424-438).

### Walk / run speed constants (Ped ctor, Ped.cpp:560-628)

Base unit `dword_6784C4 = 256 raw = 1/64 tile/tick` (Ped.cpp:72).

| field | default | value | meaning |
|---|---|---|---|
| `field_1F4` (walk) | `dword_678434 = dword_6784C4 * 2` | **0.03125 tile/tick** (512 raw; 0.94 tiles/s @30fps) | walking velocity, applied via `RegulateVelocity_433970` / `SetMaxSpeed_433920` (Ped.cpp:591, 6150-6160, 6385-6408) |
| `field_1F0_maybe_max_speed` (run) | `dword_678448 = Fix16(4) * dword_6784C4` | **0.0625 tile/tick** (1024 raw; 1.875 tiles/s) | running velocity (Ped.cpp:592, 5728-5732, 6191, 7630) |
| `field_1F8_run_speed` | `dword_6784A0 = 0x3333 raw` | **0.8** | despite the decomp name this is the **driving cruise speed** used when the ped drives a car: `CarAI_78::field_74 = driver->field_1F8_run_speed` (CarAI_78.cpp:2953). Car thief gets 4.0 (Char_Pool.cpp:213), ambulance medics 0x1999 = 0.4 (Ambulance_110.cpp:14, 83); settable by script (miss2_0x11C.cpp:5812) |

Other handy ped constants from the same block (Ped.cpp:66-129):
`dword_6784CC = 2/64` (= walk), `dword_678620 = (1/64)/4 = 0.0039` (slow
shuffle), shock threshold `field_212_electrocution_threshold = 100`
(Ped.cpp:590), default spawned health 100 (`SpawnPedChainGroupAt`,
Char_Pool.cpp:1110).

---

## 6. Car deltas (damage / light states)

Sources: `enums.hpp` (delta bit names), `Car_BC.cpp` (damage logic),
`CarPhysics_B0.cpp` (impact detection), `sprite.cpp` (night-light masking).

The engine keeps one 32-bit mask per car, `Car_BC::field_8_damaged_areas`
(`BitSet32`); **bit N = "delta N of this car's sprite is currently applied"**.
The composited car texture is rebuilt from this mask at draw time
(sprite.cpp:709-797). The canonical bit/delta assignments
(`CarDeltaBitsEnum`, enums.hpp:4-49) — note **"Top" = rear, "Bottom" =
front** (rear has brake lights, front has headlights, see
`DamageArea_43CF30`):

| delta | name | meaning |
|---:|---|---|
| 0 | TopLeftDamage | rear-left corner dent |
| 1 | TopRightDamage | rear-right corner dent |
| 2 | BottomRightDamage | front-right corner dent |
| 3 | BottomLeftDamage | front-left corner dent |
| 4 | WindshieldDamage | smashed windscreen |
| 5 | BackRightBrakeLight | brake light lit (right) |
| 6 | FrontRightHeadlight | headlight lit (right) |
| 7-10 | BottomRightDoor1-4 | front-right door anim frames (declared, **never referenced in decomp code**) |
| 11-14 | TopRightDoor1-4 | overloaded, see below |
| 15-18 | Bottom/TopLeft/Right RoofLight | roof / siren light frames |
| 19-21 | Bit19-21 | only used by racer roof numbers (below) |
| 22 | BackLeftBrakeLight | brake light lit (left) |
| 23 | FrontLeftHeadlight | headlight lit (left) |
| 24-27 | BottomLeftDoor1-4 | front-left door frames (declared, unreferenced) |
| 28-31 | TopLeftDoor1-4 | overloaded counterpart of 11-14 |

### What damage triggers each dent

- Physics collision: `CarPhysics_B0` finds the car-rect **corner nearest the
  impact point** (`Sprite::GetNearestHorizontalEdgeToCoordinate_5A0A70`,
  sprite.cpp:1284-..., corner index 0-3) and calls
  `TryDamageArea_43D2C0(corner, impulse)` (CarPhysics_B0.cpp:2577,
  2722-2723 for car-vs-car both sides, 2829).
- `TryDamageArea_43D2C0` (Car_BC.cpp:3073-3096): dent applied only if not
  already at max damage, `(field_78_flags & 8) == 0`, and
  `anti_strength * impulse >= dword_6777D0 = 0x4000 (1.0)` (Car_BC.cpp:84).
  Corner→area remap: rect corner 0→area 3, 1→2, 2→0, 3→1.
- `DamageArea_43CF30` (Car_BC.cpp:2998-3045) applies the visual state:
  - area 0 (front-right): set delta **2**, break right headlight (clear 6);
    cars with CARI `info_flags_2 & 2` clear deltas 11-14 instead.
  - area 1 (front-left): set delta **3**, clear 23 (or 28-31).
  - area 2 (rear-right): set delta **1**, clear brake light 5.
  - area 3 (rear-left): set delta **0**, clear brake light 22.
  - area 4: set windscreen delta **4** (set e.g. when a ped is thrown
    through the windscreen / script `IsAreaDamaged_43D1C0`,
    miss2_0x11C.cpp:4982).
- Car crusher / instant-wreck path dents all 4 corners at once and awards
  1000 points per fresh dent (`ProcessCarToCarImpact_43ADC0`,
  Car_BC.cpp:1907-1944).
- Repair (`sub_43D400`, Car_BC.cpp:3098-3161): clears deltas 0-4 and
  re-applies light deltas from the `field_A4` light flags.

### Lights

`field_A4` bit 1 = brake lights on, bit 2 = headlights on, bit 4/8/0x10 =
emergency-flash states.

- Headlights on (`field_A4 & 2`): set deltas 6 and 23 *unless* the matching
  front corner is dented; cars with CARI `info_flags_2 & 2` use deltas
  **11/28 as their headlight deltas instead** (pop-up/alt headlight art;
  Car_BC.cpp:2529-2580, 2894-2945, 3110-3140). Headlights enabled at
  `field_A4 |= 2` (Car_BC.cpp:2651).
- Brake lights (`field_A4 & 1`): set deltas 5 and 22 unless the rear corner
  is dented (`sub_43CBE0`, Car_BC.cpp:2894-2975; also 1733-1741).
- Roof/siren lights: deltas 15-18, flashed by
  `ActivateEmergencyLights_43C920` (Car_BC.cpp:2846-2864; flash phase 8 for
  FBI, 15 otherwise), `UpdateRoofLights_43C500` / `..BottomLeft.._43C700`
  (15/16 plus attached light objects models 165/171/172/173,
  Car_BC.cpp:2754-2819). EDSELFBI abuses deltas 11-14 as its hidden flashing
  light frames (Car_BC.cpp:2756-2760, 2852, 2876). CARI `info_flags & 4`
  marks "has roof light delta 15" (Car_BC.hpp:598-601, Car_BC.cpp:3136-3139).
- Night rendering: with lighting on, the draw pass strips the "light" delta
  bits, then a second emissive pass draws only them. Light-bit masks
  (sprite.cpp:45-47, applied :716-739, 791-797):
  `0x0C78060` (bits 5,6,15-18,22,23) normal cars, `0x0C70060` (no bit 15)
  FBI, `0x0C00060` (head/brake only) for CARI `info_flags & 0x40` cars.

### Racer roof numbers

Model `GT24640` gets a random race number at spawn: `sub_43CDF0(rng % 11)`
sets **delta 11 + n** (n = 0..9 = number art, n = 10 = no number) after
clearing deltas 11-21 (Car_BC.cpp:868-871, 2977-2996). Script command "set
the number on the top of the car" uses the same function
(miss2_0x11C.cpp:5710).

---

## 7. Car handling (ModelPhysics / nyc.gci) and collision dimensions

Sources: `CarInfo_808.hpp/.cpp`, `CarPhysics_B0.cpp`, `gtx_0x106C.hpp`,
`Game_0x40.cpp`, plus the actual data file `data/nyc.gci` from the GTA2
freeware release (a copy is now in `gamedata/nyc.gci` of this repo; it is
inside the same installer `scripts/fetch-gamedata.sh` downloads).

### Where the table lives

Handling is NOT hardcoded: it is parsed at game load from the text file
`data\nyc.gci` (`Game_0x40.cpp:159-172`; a registry debug setting "carname"
can override the file). `CarInfo_808::LoadFromGciFile_454A00`
(CarInfo_808.cpp:724-732) parses it into one `ModelPhysics_48` (0x48 bytes)
per car model, indexed by model id (`field_404_model_physics_array`,
CarInfo_808.cpp:684-688). Token format: `{comment}` blocks ignored; values
prefixed `b/w/l/f` (byte/word/dword/fix16) with optional `h` hex / `-`
(sub_430C70, CarInfo_808.cpp:150-329; `fX.YYY` is converted via
`FloatStrToFix16_431000`, value * 0x4000, :486-514).

### ModelPhysics_48 fields (CarInfo_808.hpp:53-85, in gci file order)

| offset | field | unit / use |
|---|---|---|
| 0x00 | model (u8) | car model id |
| 0x01 | turbo (s8) | 1 = has turbo (boosts thrust, `ComputeThrustWithTurbo_5618F0`, CarInfo_808.cpp:569-583) |
| 0x02 | value (u8) | cost/score value |
| 0x04 | mass | engine multiplies by 1.1 at load (`ConvertMass_454680`: `mass *= (0.1 + 1.0)`, CarInfo_808.cpp:60-64) |
| 0x08 | front drive bias | torque split front/rear (CarPhysics_B0.cpp:3267, 1966) |
| 0x0C | front mass bias | weight distribution; feeds moment of inertia + CG offset (`ComputeCarMassAndInertia_454410`, CarInfo_808.cpp:549-567) |
| 0x10 | brake friction | brake force scale (CarPhysics_B0.cpp:3414, 3489) |
| 0x14 | turn in | steering response (CarPhysics_B0.cpp:3271, 3350) |
| 0x18 | turn ratio | steering ratio (CarPhysics_B0.cpp:466-470) |
| 0x1C | rear end stability | scales rear lateral grip (CarPhysics_B0.cpp:3429-3430) |
| 0x20 | handbrake slide value | handbrake slide force (CarPhysics_B0.cpp:3412) |
| 0x24 | thrust | engine force; engine uses thrust/2 + thrust/5 (+turbo) (CarInfo_808.cpp:628-631) |
| 0x28 | max_speed | top speed, tiles/tick (also drives traffic cruise bands, section 4; CarPhysics_B0.cpp:3710) |
| 0x2C | anti strength | damage resistance; collision dent threshold uses `anti_strength * impulse >= 1.0` (Car_BC.cpp:1378, 3076) |
| 0x30 | skid threshold | grip limits; derives the two skid thresholds `* (1 ± 0.1)` (CarInfo_808.cpp:633-634) |
| 0x34-0x3C | gear1/2/3 multiplier | torque multiplier per gear; gear chosen by speed vs gear2_speed / gear3_speed (CarPhysics_B0.cpp:3193-3216) |
| 0x40/0x44 | gear2_speed / gear3_speed | gear shift points (must be `<= max_speed` or fatal error, CarInfo_808.cpp:590-596) |

### Per-model values (from `nyc.gci`, "Generated 14/9/1999")

| field | Cop Car (12) | Bug (8) | T-Rex / TBIRD (57) | Tank (54) | Romero (0) |
|---|---|---|---|---|---|
| turbo | 1 | 0 | 0 | 0 | 0 |
| value | 60 | 10 | 50 | 95 | 50 |
| mass | 14.5 | 6.3 | 15.5 | 45.0 | 16.5 |
| front drive bias | 1.0 | 1.0 | 1.0 | 0.5 | 1.0 |
| front mass bias | 0.5 | 0.45 | 0.55 | 0.5 | 0.5 |
| brake friction | 2.0 | 1.265 | 2.0 | 4.0 | 1.75 |
| turn in | 0.433 | 0.30 | 0.35 | 0.25 | 0.145 |
| turn ratio | 0.40 | 0.175 | 0.35 | 0.75 | 0.45 |
| rear end stability | 1.25 | 1.5 | 0.95 | 4.0 | 1.25 |
| handbrake slide | 0.40 | 0.65 | 0.35 | 0.0 | 0.18 |
| thrust | 0.150 | 0.095 | 0.225 | 0.290 | 0.152 |
| max_speed | 0.415 | 0.235 | 0.405 | 0.100 | 0.245 |
| anti strength | 1.0 | 1.0 | 1.0 | 0.25 | 1.0 |
| skid threshold | 0.115 | 0.050 | 0.115 | 0.500 | 0.065 |
| gear 1/2/3 mult | .55/.68/1.0 | .55/.625/1.0 | .55/.65/1.0 | .53/.60/1.0 | .55/.68/1.0 |
| gear2/gear3 speed | .180/.290 | .125/.152 | .175/.255 | .050/.060 | .107/.165 |

(speeds in tiles/tick: cop car tops out at 0.415 tiles/tick = 12.45 tiles/s
at 30 fps.)

### Collision width/height vs CARI w/h

The CARI chunk's `w`/`h` bytes (car_info, gtx_0x106C.hpp:76-95) are **in
pixels, 64 px = 1 tile**, and are what the engine uses for the car's
collision rect — not the sprite bitmap size:

- Lookup table `UnknownList dword_6F6850`: `list[i] = Fix16(i)/64`
  (CarInfo_808.hpp:18-49).
- Car spawn allocates the collision sprite with
  `AllocInternal_59F950(list[pCarInfo->w], list[pCarInfo->h], dword_6771FC)`
  (Car_BC.cpp:811) — i.e. collision box = CARI w x h pixels converted to
  tiles.
- The *rendered* quad instead uses the sprite page entry's own
  width/height (`pSpriteIndex->field_4_width/field_5_height`,
  sprite.cpp:698-699), so CARI w/h may legitimately differ from the art.
- The same CARI w/h feed physics: moment of inertia / CG
  (CarInfo_808.cpp:621-627), water/edge checks (Car_BC.cpp:564-567,
  1496-1503), gun/exit positions (`Fix16(pCarInfo->w)/2`,
  Car_BC.cpp:1290-1291), SMG muzzle x-offset (Car_BC.cpp:2377-2404).
- Wheel offsets `front/rear_wheel_offset` (CARI, signed bytes) use the same
  /64 conversion (CarInfo_808.cpp:598-619).

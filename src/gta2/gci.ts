/**
 * Parser for GTA2 car handling files (nyc.gci) — a text format parsed by the
 * original engine at load (CarInfo_808::LoadFromGciFile_454A00). Each car is
 * a `{Name}` header followed by `value {field}` lines; floats are written
 * `fX.YYY` (Fix16 in the engine, plain numbers here).
 *
 * Units (docs/gta2-reference.md §7): speeds are tiles/tick @30fps,
 * thrust is engine force (effective accel ~ thrust * gearMult / mass).
 */

export interface ModelPhysics {
  name: string;
  model: number;
  turbo: boolean;
  value: number;
  /** engine multiplies by 1.1 at load (ConvertMass_454680) */
  mass: number;
  frontDriveBias: number;
  frontMassBias: number;
  brakeFriction: number;
  turnIn: number;
  turnRatio: number;
  rearEndStability: number;
  handbrakeSlide: number;
  thrust: number;
  /** tiles/tick (multiply by 30 for tiles per second) */
  maxSpeed: number;
  antiStrength: number;
  skidThreshold: number;
  gearMult: [number, number, number];
  /** shift points, tiles/tick */
  gear2Speed: number;
  gear3Speed: number;
}

const FIELD_KEYS: Record<string, string> = {
  'model': 'model',
  'turbo': 'turbo',
  'value': 'value',
  'mass': 'mass',
  'front drive bias': 'frontDriveBias',
  'front mass bias': 'frontMassBias',
  'brake friction': 'brakeFriction',
  'turn in': 'turnIn',
  'turn ratio': 'turnRatio',
  'rear end stability': 'rearEndStability',
  'handbrake slide value': 'handbrakeSlide',
  'thrust': 'thrust',
  'max_speed': 'maxSpeed',
  'anti strength': 'antiStrength',
  'skid threshhold': 'skidThreshold', // sic, typo in the original file
  'gear2 speed': 'gear2Speed',
  'gear3 speed': 'gear3Speed',
};

export function parseGci(text: string): Map<number, ModelPhysics> {
  const out = new Map<number, ModelPhysics>();
  // Strip multi-line {*** ... ***} comment banners but keep single-line tags.
  const lines = text.split(/\r?\n/);
  let cur: Partial<ModelPhysics> & { gearMult?: [number, number, number] } | null = null;
  let curName = '';
  let inBanner = false;

  const flush = () => {
    if (cur && cur.model !== undefined && cur.maxSpeed !== undefined) {
      cur.name = curName;
      // ConvertMass_454680: mass *= 1.1 at load
      cur.mass = (cur.mass ?? 10) * 1.1;
      out.set(cur.model, cur as ModelPhysics);
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('{*')) { inBanner = true; }
    if (inBanner) {
      if (line.endsWith('*}')) inBanner = false;
      continue;
    }
    if (!line) continue;

    // Header: a line that is only `{Name}`
    const header = /^\{([^}]+)\}$/.exec(line);
    if (header) {
      flush();
      curName = header[1];
      cur = { gearMult: [1, 1, 1], turbo: false };
      continue;
    }

    const m = /^(f?-?[\d.]+)h?\s*\{([^}]+)\}/.exec(line);
    if (!m || !cur) continue;
    const num = parseFloat(m[1].replace(/^f/, ''));
    const tag = m[2].trim();

    const gear = /^gear([123]) multiplier$/.exec(tag);
    if (gear) {
      cur.gearMult![parseInt(gear[1], 10) - 1] = num;
      continue;
    }
    const key = FIELD_KEYS[tag];
    if (!key) continue;
    if (key === 'turbo') cur.turbo = num !== 0;
    else (cur as Record<string, unknown>)[key] = num;
  }
  flush();
  return out;
}

#!/usr/bin/env node
// Downloads the official GTA2 freeware release (Rockstar, 2004) and extracts
// the data files this game needs into gamedata/. Pure Node (7z-wasm) so it
// also runs in CI build images — wired up as the npm "prebuild" hook.
// Env overrides: GTA2_INSTALLER (path to a pre-downloaded installer exe),
// GAMEDATA_DIR (output dir, default <repo>/gamedata).
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.GAMEDATA_DIR ?? path.join(repoRoot, 'gamedata');
const URL = 'https://gtamp.com/GTA2/gta2-installer.exe';

const DATA_FILES = ['wil.gmp', 'wil.sty', 'ste.gmp', 'ste.sty', 'bil.gmp', 'bil.sty', 'fstyle.sty', 'nyc.gci'];
const AUDIO_FILES = ['wil.sdt', 'wil.raw', 'ste.sdt', 'ste.raw', 'bil.sdt', 'bil.raw', 'fstyle.sdt', 'fstyle.raw'];

function ensurePublicSymlink() {
  const link = path.join(repoRoot, 'public', 'gamedata');
  if (!fs.existsSync(link)) fs.symlinkSync('../gamedata', link);
}

if (fs.existsSync(path.join(outDir, 'wil.gmp')) && fs.existsSync(path.join(outDir, 'wil.sty'))) {
  console.log('gamedata already present');
  ensurePublicSymlink();
  process.exit(0);
}

let installer;
if (process.env.GTA2_INSTALLER) {
  installer = fs.readFileSync(process.env.GTA2_INSTALLER);
} else {
  console.log('downloading GTA2 freeware installer…');
  try {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    installer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // Some environments (proxies, sandboxes) block Node's fetch but allow curl.
    console.log(`fetch failed (${err.cause?.code ?? err.message}), retrying with curl…`);
    const { execFileSync } = await import('node:child_process');
    installer = execFileSync('curl', ['-sL', '--fail', URL], { maxBuffer: 256 * 1024 * 1024 });
  }
}

console.log('extracting data files…');
const SevenZip = (await import('7z-wasm')).default;
const sz = await SevenZip({ quiet: true, print: () => {}, printErr: () => {} });
sz.FS.writeFile('/installer.exe', installer);
sz.FS.mkdir('/x');
const code = sz.callMain(['x', '-y', '-o/x', '/installer.exe']);
if (code !== 0) throw new Error(`7z extraction failed with code ${code}`);

// Walk the extracted tree once, indexing by lowercased basename (the
// installer's casing varies), mirroring the old script's `find -iname`.
const byName = new Map();
const vocalDirs = [];
(function walk(dir) {
  for (const name of sz.FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const p = `${dir}/${name}`;
    if (sz.FS.isDir(sz.FS.stat(p).mode)) {
      if (name.toLowerCase() === 'vocals') vocalDirs.push(p);
      walk(p);
    } else if (!byName.has(name.toLowerCase())) {
      byName.set(name.toLowerCase(), p);
    }
  }
})('/x');

fs.mkdirSync(path.join(outDir, 'audio', 'vocals'), { recursive: true });

const copyOut = (srcPath, dest) => fs.writeFileSync(dest, sz.FS.readFile(srcPath));
let found = 0;
for (const f of DATA_FILES) {
  const src = byName.get(f);
  if (src) { copyOut(src, path.join(outDir, f)); found++; }
}
console.log(`copied ${found}/${DATA_FILES.length} data files into ${path.relative(repoRoot, outDir) || '.'}/`);

for (const f of AUDIO_FILES) {
  const src = byName.get(f);
  if (src) copyOut(src, path.join(outDir, 'audio', f));
}
if (vocalDirs.length) {
  let vocals = 0;
  for (const name of sz.FS.readdir(vocalDirs[0])) {
    if (name.toLowerCase().endsWith('.wav')) {
      copyOut(`${vocalDirs[0]}/${name}`, path.join(outDir, 'audio', 'vocals', name));
      vocals++;
    }
  }
  console.log(`copied ${vocals} vocal samples`);
}

const magic = (file) => fs.readFileSync(path.join(outDir, file)).subarray(0, 4).toString('ascii');
if (magic('wil.gmp') !== 'GBMP') throw new Error('wil.gmp magic check failed');
if (magic('wil.sty') !== 'GBST') throw new Error('wil.sty magic check failed');
console.log('wil.gmp OK (GBMP), wil.sty OK (GBST)');
ensurePublicSymlink();

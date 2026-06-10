#!/usr/bin/env bash
# Downloads the official GTA2 freeware release (Rockstar, 2004) and extracts
# the data files this game needs into gamedata/. Requires 7zz (brew install sevenzip).
set -euo pipefail
cd "$(dirname "$0")/.."

URL="https://gtamp.com/GTA2/gta2-installer.exe"
mkdir -p gamedata
if [ -f gamedata/wil.gmp ] && [ -f gamedata/wil.sty ]; then
  echo "gamedata already present"
  exit 0
fi

command -v 7zz >/dev/null || { echo "7zz not found — brew install sevenzip"; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "downloading GTA2 freeware installer…"
curl -L --fail -o "$tmp/gta2-installer.exe" "$URL"
echo "extracting data files…"
7zz x -y -o"$tmp/x" "$tmp/gta2-installer.exe" >/dev/null
found=0
for f in wil.gmp wil.sty ste.gmp ste.sty bil.gmp bil.sty fstyle.sty; do
  src=$(find "$tmp/x" -iname "$f" | head -1)
  if [ -n "$src" ]; then
    cp "$src" "gamedata/$f"
    found=$((found + 1))
  fi
done
echo "copied $found files into gamedata/"
xxd -l 4 gamedata/wil.gmp | grep -q GBMP && echo "wil.gmp OK (GBMP)"
xxd -l 4 gamedata/wil.sty | grep -q GBST && echo "wil.sty OK (GBST)"

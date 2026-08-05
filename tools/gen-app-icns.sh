#!/bin/bash
# Regenerate the LumenTranslation macOS app icon (AppIcon.icns) from its
# source SVG (AppIcon.svg, the Lumen Translation product icon).
#
# Run this after editing AppIcon.svg. Requires rsvg-convert (brew install
# librsvg) and iconutil (ships with macOS). build.sh embeds the resulting
# AppIcon.icns into the app bundle and sets CFBundleIconFile.
#
# Usage: tools/gen-app-icns.sh
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="apps/popclip-window/LumenTranslation/AppIcon.svg"
OUT="apps/popclip-window/LumenTranslation/AppIcon.icns"

command -v rsvg-convert >/dev/null || { echo "need rsvg-convert (brew install librsvg)"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SET="$WORK/AppIcon.iconset"
mkdir -p "$SET"

# Render each required size directly from the SVG for sharpness.
gen() { rsvg-convert -w "$1" -h "$1" "$SRC" -o "$SET/$2"; }
gen 16   icon_16x16.png
gen 32   icon_16x16@2x.png
gen 32   icon_32x32.png
gen 64   icon_32x32@2x.png
gen 128  icon_128x128.png
gen 256  icon_128x128@2x.png
gen 256  icon_256x256.png
gen 512  icon_256x256@2x.png
gen 512  icon_512x512.png
gen 1024 icon_512x512@2x.png

iconutil -c icns "$SET" -o "$OUT"
echo "wrote $OUT"

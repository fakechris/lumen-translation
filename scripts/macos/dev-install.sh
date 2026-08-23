#!/usr/bin/env bash
# Build release bundle → stable-sign the .app → install into /Applications.
#
# Daily local loop for the macOS live-subtitle work, mirroring lumen-asr's
# dev-install.sh. Signing with the stable "Lumen Local Codesign" identity
# (see lumen-asr's ensure-local-identity.sh) keeps the TCC grants (System
# Audio Recording) across rebuilds; ad-hoc signing would re-prompt every
# build.
#
# Usage:
#   ./scripts/macos/dev-install.sh          # frontend + backend + install
#   ./scripts/macos/dev-install.sh --open   # also launch
#   LUMEN_CODESIGN_IDENTITY="Apple Development: …" ./scripts/macos/dev-install.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DESKTOP="$ROOT/apps/desktop"
APP_SRC="$DESKTOP/src-tauri/target/release/bundle/macos/Lumen Translation.app"
IDENTITY="${LUMEN_CODESIGN_IDENTITY:-Lumen Local Codesign}"
INSTALL_DEST="${LUMEN_INSTALL_DEST-/Applications/Lumen Translation.app}"
OPEN_APP=0

for arg in "$@"; do
  case "$arg" in
    --open) OPEN_APP=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

echo "==> building frontend"
cd "$DESKTOP"
pnpm install --silent
pnpm build

echo "==> building release bundle (tauri)"
pnpm tauri build 2>&1 | tail -5
if [[ ! -d "$APP_SRC" ]]; then
  echo "ERROR: bundle not produced at: $APP_SRC" >&2
  exit 1
fi

echo "==> signing with '$IDENTITY'"
codesign --force --deep --sign "$IDENTITY" "$APP_SRC"
codesign --verify --strict "$APP_SRC"

echo "==> installing to $INSTALL_DEST"
rm -rf "$INSTALL_DEST"
ditto "$APP_SRC" "$INSTALL_DEST"

echo "Installed: $INSTALL_DEST"
echo "Identity:  $IDENTITY"
if [[ "$OPEN_APP" == "1" ]]; then
  open "$INSTALL_DEST"
fi

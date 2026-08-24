#!/usr/bin/env bash
# Build release bundle → stable-sign the .app → install into /Applications.
#
# Daily local loop for the macOS live-subtitle work. Signing with the stable
# "Lumen Local Codesign" identity keeps the TCC grants (System
# Audio Recording) across rebuilds; ad-hoc signing would re-prompt every
# build. The signature must also carry scripts/macos/entitlements.dev.plist,
# matching the entitlement set used by the other local Lumen macOS apps.
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
ENTITLEMENTS="${LUMEN_CODESIGN_ENTITLEMENTS:-$ROOT/scripts/macos/entitlements.dev.plist}"
INSTALL_DEST="${LUMEN_INSTALL_DEST-/Applications/Lumen Translation.app}"
APP_BUNDLE_ID="app.lumen.translation"
OPEN_APP=0

for arg in "$@"; do
  case "$arg" in
    --open) OPEN_APP=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

case "$INSTALL_DEST" in
  /*.app) ;;
  *)
    echo "ERROR: install destination must be an absolute .app path: $INSTALL_DEST" >&2
    exit 1
    ;;
esac

installed_executable="$INSTALL_DEST/Contents/MacOS/lumen-translation-desktop"
running_installed_pids() {
  pgrep -f -x "$installed_executable" 2>/dev/null || true
}

stop_installed_app() {
  local pids
  pids="$(running_installed_pids)"
  [[ -z "$pids" ]] && return 0

  echo "==> stopping installed app (pid ${pids//$'\n'/, })"
  osascript -e "tell application id \"$APP_BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in {1..50}; do
    [[ -z "$(running_installed_pids)" ]] && return 0
    sleep 0.1
  done

  pids="$(running_installed_pids)"
  [[ -z "$pids" ]] && return 0
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && kill -TERM "$pid"
  done <<< "$pids"
  for _ in {1..30}; do
    [[ -z "$(running_installed_pids)" ]] && return 0
    sleep 0.1
  done

  echo "ERROR: installed app did not exit; refusing to replace a running binary" >&2
  return 1
}

echo "==> building frontend"
cd "$DESKTOP"
pnpm install --silent
pnpm build

echo "==> building release bundle (tauri)"
pnpm tauri build --bundles app 2>&1 | tail -5
if [[ ! -d "$APP_SRC" ]]; then
  echo "ERROR: bundle not produced at: $APP_SRC" >&2
  exit 1
fi

echo "==> signing with '$IDENTITY'"
SIGN_ARGS=(--force --deep --sign "$IDENTITY")
# Keep the stable local signature and its audio/automation capabilities
# together so TCC sees the rebuilt app as the same local application.
if [[ -f "$ENTITLEMENTS" ]]; then
  SIGN_ARGS+=(--entitlements "$ENTITLEMENTS")
else
  echo "WARN: entitlements not found at $ENTITLEMENTS — permissions may need to be granted again" >&2
fi
codesign "${SIGN_ARGS[@]}" "$APP_SRC"
codesign --verify --strict "$APP_SRC"

echo "==> installing to $INSTALL_DEST"
stop_installed_app
rm -rf "$INSTALL_DEST"
ditto "$APP_SRC" "$INSTALL_DEST"

echo "Installed: $INSTALL_DEST"
echo "Identity:  $IDENTITY"
if [[ "$OPEN_APP" == "1" ]]; then
  open "$INSTALL_DEST"
  for _ in {1..50}; do
    if [[ -n "$(running_installed_pids)" ]]; then
      echo "Running PID: $(running_installed_pids | tr '\n' ' ')"
      exit 0
    fi
    sleep 0.1
  done
  echo "ERROR: installed app did not launch" >&2
  exit 1
fi

#!/bin/bash
# Build LumenTranslation.app — a companion window for the PopClip Lumen
# extension. AppleScript-aware: PopClip's action sends
#   tell application "LumenTranslation" to translate "text" with options {...}
# and macOS routes the Apple Event to our handler.
set -euo pipefail

cd "$(dirname "$0")"

APP_NAME="LumenTranslation"
APP_DIR="dist/${APP_NAME}.app"
CONTENTS="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS}/MacOS"
RESOURCES_DIR="${CONTENTS}/Resources"

rm -rf "${APP_DIR}"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}"

# Compile all Swift sources together.
swiftc \
  -target arm64-apple-macosx13.0 \
  -sdk "$(xcrun --show-sdk-path)" \
  -parse-as-library \
  -O \
  -module-name LumenTranslation \
  -o "${MACOS_DIR}/${APP_NAME}" \
  "${APP_NAME}/${APP_NAME}App.swift" \
  "${APP_NAME}/ProviderCatalog.swift" \
  "${APP_NAME}/Preferences.swift" \
  "${APP_NAME}/LLMService.swift" \
  "${APP_NAME}/Languages.swift" \
  "${APP_NAME}/PreferencesWindow.swift"

# Copy the scripting definition (AppleScript `translate` keyword).
cp "${APP_NAME}/${APP_NAME}.sdef" "${RESOURCES_DIR}/${APP_NAME}.sdef"

# Provider presets are data-driven: bundle the vendored lumen-suite provider
# catalog contract (lumen.provider-catalog/v1). The JSON is a byte-for-byte
# copy of lumen-suite contracts/provider-catalog.v1.json, refreshed via
# `node scripts/sync-provider-catalog.mjs` — never hand-edit it.
cp ../../packages/engines/src/provider-catalog.v1.json \
  "${RESOURCES_DIR}/provider-catalog.v1.json"

# Copy the menu bar template icon.
cp "${APP_NAME}/statusicon.png" "${RESOURCES_DIR}/statusicon.png"

# Copy the app icon (Finder / Settings window / About). Source of truth is
# AppIcon.svg (the Lumen Translation product icon); AppIcon.icns is generated
# from it via tools + iconutil.
cp "${APP_NAME}/AppIcon.icns" "${RESOURCES_DIR}/AppIcon.icns"

# Info.plist
cat > "${CONTENTS}/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>LumenTranslation</string>
  <key>CFBundleDisplayName</key>
  <string>Lumen Translation</string>
  <key>CFBundleIdentifier</key>
  <string>app.lumen.translation</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>LumenTranslation</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIconName</key>
  <string>AppIcon</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppleScriptEnabled</key>
  <true/>
  <key>OSAScriptingDefinition</key>
  <string>LumenTranslation.sdef</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST

# PkgInfo
echo -n "APPL????" > "${CONTENTS}/PkgInfo"

echo "wrote ${APP_DIR}"


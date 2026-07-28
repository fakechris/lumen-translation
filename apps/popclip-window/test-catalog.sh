#!/bin/bash
# Smoke test: compile the catalog adapter with swiftc (no app bundle needed)
# and verify the vendored provider catalog decodes into the presets the app
# expects. Run: bash apps/popclip-window/test-catalog.sh
set -euo pipefail

cd "$(dirname "$0")"

CATALOG_JSON="../../packages/engines/src/provider-catalog.v1.json"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

swiftc \
  -target arm64-apple-macosx13.0 \
  -sdk "$(xcrun --show-sdk-path)" \
  -o "${TMP}/catalog-smoke" \
  LumenTranslation/ProviderCatalog.swift \
  tests/main.swift

"${TMP}/catalog-smoke" "${CATALOG_JSON}"

#!/bin/bash
# Smoke test: compile TranslationService (LLMService.swift) with its
# dependencies as a plain CLI and verify the long-text chunker behaves.
# Run: bash apps/popclip-window/test-chunking.sh
set -euo pipefail

cd "$(dirname "$0")"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

swiftc \
  -target arm64-apple-macosx13.0 \
  -sdk "$(xcrun --show-sdk-path)" \
  -parse-as-library \
  -o "${TMP}/chunking-smoke" \
  LumenTranslation/LLMService.swift \
  LumenTranslation/Preferences.swift \
  LumenTranslation/ProviderCatalog.swift \
  tests/chunking-main.swift

"${TMP}/chunking-smoke"

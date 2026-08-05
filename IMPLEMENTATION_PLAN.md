# Windows port — implementation plan

Goal: bring Lumen Translation's desktop experience to Windows. macOS ships a
Swift/AppKit menu-bar app (`apps/popclip-window`) driven by PopClip. **PopClip
does not exist on Windows**, so the selection-popup half of the product has to
be built from scratch alongside the translation window itself.

Packaging and CI mirror the sibling `lumen-asr` repo: Tauri v2, unsigned NSIS
current-user installer for direct download, plus an MSIX for Microsoft Store
ingestion, both produced by `windows-latest` GitHub runners.

## What is macOS-only today

| Area | macOS today | Windows plan |
| --- | --- | --- |
| Selection popup | PopClip extension (`apps/popclip`) | Native selection watcher + action bar (new) |
| Translation window | Swift/AppKit `apps/popclip-window` | Tauri v2 `apps/desktop` |
| IPC | AppleScript `translate` / `configure` verbs | Tauri commands + events |
| Prefs storage | `UserDefaults` | JSON under `%APPDATA%\Lumen Translation` |
| Global hotkey | Carbon `RegisterEventHotKey` | `tauri-plugin-global-shortcut` |
| Menu bar | `NSStatusItem` | Tray icon + menu |
| Speak | `NSSpeechSynthesizer` | Web Speech API in WebView2 |
| App icon | `.icns` via `swiftc` + `iconutil` | `.ico` / MSIX PNG assets via Node |

Everything else in the repo (extension, userscript, mobile, worker, and all of
`packages/*`) is already platform-neutral JS/TS and needs no port.

## Stage 1: Tauri shell
**Goal**: `apps/desktop` builds and runs on Windows with a tray icon.
**Success criteria**: `pnpm --filter @lumen/desktop tauri build --bundles nsis`
produces an installer; tray menu opens Preferences and quits.
**Status**: Complete

## Stage 2: Translation core
**Goal**: Provider catalog + fallback chain ported to TS, reusing
`@lumen/engines` rather than reimplementing provider logic.
**Success criteria**: `catalog.ts` resolves the same curated ids, aliases and
legacy ids as `ProviderCatalog.swift`; the fallback chain matches
`LLMService.swift`. Unit tests cover both.
**Status**: Complete

## Stage 3: Windows PopClip replacement
**Goal**: Select text in any app -> a small action bar appears near the cursor
-> click it -> translation window opens.
**Success criteria**: Works in Win32 (Notepad), UWP, Chromium and Electron
apps; never fires on password fields; clipboard is restored byte-for-byte when
the copy fallback is used.
**Status**: Complete (pending on-device verification)

## Stage 4: Packaging
**Goal**: NSIS + MSIX, icons, CI.
**Success criteria**: `ci-windows.yml` green; MSIX passes MakeAppx validation.
**Status**: Complete (pending CI run)

## Stage 5: On-device verification
**Goal**: Run the checklist in `docs/WINDOWS_PORT_STATUS.md` on real hardware.
**Success criteria**: Every item in "Verification pending" is checked off.
**Status**: Not Started — needs a Windows machine

# Lumen Translation

> A complete open-source bilingual translation product matrix. Apache-2.0, privacy-first, cross-platform, engine-agnostic.

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Build](https://github.com/fakechris/lumen-translation/actions/workflows/ci.yml/badge.svg)](https://github.com/fakechris/lumen-translation/actions/workflows/ci.yml)
[![Release](https://github.com/fakechris/lumen-translation/actions/workflows/release.yml/badge.svg)](https://github.com/fakechris/lumen-translation/releases)

Lumen Translation lets you read, write, watch, and attend meetings in any language. It runs as a browser extension, a userscript, a macOS PopClip extension, a mobile app shell, and a self-hostable sync backend, all built on a shared core of independently importable npm packages.

- **License**: Apache-2.0 (commercial-friendly, no copyleft).
- **Privacy**: all settings stay local; AI calls use your own keys; no proxy, no telemetry, no ads.
- **Current release**: [v0.1.0](https://github.com/fakechris/lumen-translation/releases/tag/v0.1.0) — Phase 1 MVP + Phase 2/3 frameworks.

---

## Quick start (onboarding)

The fastest way to try Lumen is the **browser extension** — three steps, about two minutes, no account required.

1. **Install** — Download `lumen-chrome.zip` from the [latest release](https://github.com/fakechris/lumen-translation/releases/latest), unzip it, open `chrome://extensions`, turn on **Developer mode** (top-right), click **Load unpacked**, and select the unzipped folder.
2. **Pick an engine** — Click the Lumen toolbar icon → **Options**. The default **Google Translate** works with no key. For higher-quality LLM translation, choose a provider (OpenAI, DeepSeek, GLM, Kimi, …) and paste **your own API key** — it never leaves your device.
3. **Translate** — On any page press **`Alt+Q`** to render it bilingually. Select text and press **`Alt+S`** for a selection popup. Hold **`Alt`** and hover a paragraph to translate just that block.

That's it — no sign-in, no proxy, no telemetry. Settings, rules, and API keys stay local.

> Prefer another surface? See [Installation](#installation) for the userscript, macOS PopClip + companion app, mobile shell, and self-hosted sync.

---

## Table of contents

- [Quick start (onboarding)](#quick-start-onboarding)
- [Product capabilities](#product-capabilities)
- [Translation engines](#translation-engines)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Installation](#installation)
- [Architecture](#architecture)
- [Development](#development)
- [Milestones](#milestones)
- [Privacy](#privacy)
- [License](#license)

---

## Product capabilities

### Web page translation

- **Bilingual side-by-side**: paragraph-level smart detection renders the translation next to the original while preserving inline formatting (links, emphasis, code).
- **Translation-only mode**: hide the original and show just the translated text.
- **Rich-text preservation**: links, styles, and structure are kept intact; no flat-text replacement.
- **Per-site rules**: override detection selectors, translation scope, and engine per URL glob (personal > subscription > global precedence).
- **Rule subscriptions**: subscribe to a JSON URL and merge community rules into your local set.

### In-page actions

- **Selection translation** — select text, get a popup with the translation, stream output for LLM engines, and one-click copy.
- **Hover translation** — hold `Alt` and hover any paragraph/block to translate just that block.
- **Input box translation** — translate the text inside the focused `<input>`/`<textarea>` in place (write in your language, send in theirs).
- **Floating ball** — a persistent on-page toggle to translate/clear the whole page.
- **Context menu** — right-click the page, a selection, or an editable field to translate.

### Video subtitles

Bilingual subtitles on major video platforms, injected via DOM observation with per-platform selectors and a translation cache:

- YouTube
- Bilibili
- Netflix
- Amazon Prime Video
- Vimeo
- Generic (fallback adapter for other HTML5 players)

Subtitle processing includes short-cue merging, long-cue splitting, and an AI re-segmentation hook (`@lumen/subtitles`). A `VideoPlatformAdapter` framework lets the community add new platforms without touching the core.

### Live meeting captions

Real-time bilingual caption overlay for online meetings, with speaker-aware batching and debounced flushing:

- Google Meet
- Microsoft Teams
- Zoom

A `CaptionAdapter` framework (`@lumen/meetings`) polls/observes each platform's caption DOM and pipes text through `createCaptionTranslator` into a floating bilingual overlay.

### PDF translation

- Open PDFs in the in-extension PDF reader (pdf.js worker bundled).
- `translatePdf` extracts text, groups it into paragraphs, and `renderBilingualPdf` reflows a bilingual document (not an overlay), preserving reading order.
- Scanned-PDF OCR via `@lumen/ocr` (Tesseract.js, lazy-loaded).

### Document file translation

The file-translator page handles plain-text and e-book formats. ePub is parsed and bilingual-rendered for reading; download is available for TXT, Markdown, and HTML:

- **TXT**
- **Markdown** (bilingual render, structure preserved)
- **HTML** (DOM-aware bilingual serialization)
- **ePub** (unzipped via jszip, OPF spine walked, each chapter bilingual-rendered for reading)

### Image translation

- The image-translator page dynamically loads Tesseract.js, OCRs the uploaded image, auto-detects the OCR language from the target language (`zh` → `chi_sim+eng`, `ja` → `jpn`, etc.), translates, and shows the result.
- An `inpaintImage` placeholder is provided for future text-region masking.

### Cross-device sync

- **WebDAV** backend (any WebDAV server: Nextcloud,坚果云, Synology, etc.).
- **Self-hosted Worker** backend (`apps/worker`, Cloudflare Workers + KV, Bearer auth, `/health` + `/snapshot` GET/PUT).
- Three merge strategies (`local-wins`, `remote-wins`, `merge-rules`) via `syncOnce`.
- Configure and test connection from the options sync panel.

### Internationalization

- UI in **English** and **中文**, auto-detected from browser language.
- Per-engine model dropdowns, region selectors (domestic/overseas), and "get API key" docs links.

### External event API

Other tools can drive Lumen via a `window` `CustomEvent` named `lumen`:

```js
window.dispatchEvent(new CustomEvent('lumen', { detail: { action: 'toggle_translate' } }));
// actions: toggle_translate | translate_selection | translate_input
```

---

## Translation engines

Engines are grouped in the options UI. All LLM engines are OpenAI-compatible and accept your own API key.

| Group              | Engines                                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Free (no key)**  | Google Translate, Microsoft Translator                                                                                                                                                                            |
| **Classic MT**     | DeepL (Free/Pro)                                                                                                                                                                                                  |
| **LLM · China**    | DeepSeek 深度求索, GLM 智谱 BigModel, Kimi 月之暗面, MiniMax 海螺, 豆包 字节火山 Ark, 通义千问 阿里 DashScope, 腾讯混元 Hunyuan, 百度文心 ERNIE, 讯飞星火 Spark, 百川 Baichuan, 零一万物 Yi, 硅基流动 SiliconFlow |
| **LLM · Overseas** | OpenRouter (aggregator, 100+ models)                                                                                                                                                                              |
| **Local / Custom** | Ollama (local), OpenAI-compatible custom endpoint                                                                                                                                                                 |

LLM features:

- **Streaming output** (SSE parser) for all OpenAI-compatible engines.
- **Batch + concurrency control** with segment deduplication (`dedupeSegments`) so identical sentences are translated once.
- **AI glossary / terminology dictionary**, filtered per batch so only terms that actually appear in the text are sent — long glossaries cost no extra tokens on unrelated content.
- **Native-speaker system prompt** with a priority order (exact names and glossary terms → tone → natural phrasing over word-for-word), inline-marker examples, and explicit "output only the translation" formatting rules.
- **Cross-paragraph context**: PDF translation feeds each paragraph the tail of the previous one as read-only context, so terminology and tone stay consistent across page breaks.
- **MiniMax & SiliconFlow region toggle** (domestic / overseas endpoint).
- **Model presets** per provider with a custom-model fallback.

---

## Keyboard shortcuts

| Shortcut    | Action                         |
| ----------- | ------------------------------ |
| `Alt+Q`     | Translate / clear current page |
| `Alt+S`     | Translate selection            |
| `Alt+Hover` | Translate hovered block        |

Plus right-click context-menu entries for page, selection, and editable fields.

---

## Installation

### Chrome / Edge (MV3)

1. Download `lumen-chrome.zip` from the [latest release](https://github.com/fakechris/lumen-translation/releases/latest).
2. Unzip.
3. `chrome://extensions` → enable Developer mode → Load unpacked → select the folder.

### Firefox (MV2)

1. Download `lumen-firefox.zip`.
2. `about:debugging` → This Firefox → Load Temporary Add-on → select the unzipped `manifest.json`.

### Safari (macOS)

Requires macOS + Xcode. Build scripts are ready:

```bash
pnpm --filter @lumen/extension safari:init   # generate the Xcode project
pnpm --filter @lumen/extension safari:build  # build & open in Safari
```

### Userscript (Tampermonkey / Violentmonkey)

Install `lumen.user.js` from the release assets. A lighter fallback that reuses `@lumen/core` / `@lumen/engines` / `@lumen/dom`.

### macOS PopClip + Lumen Translation app

The macOS experience is **two pieces that work together**:

- **Lumen PopClip extension** (`apps/popclip`) — adds a **Lumen** button to the PopClip bar when you select text.
- **Lumen Translation.app** (`apps/popclip-window`) — a menu-bar companion that renders the translation in a floating window near your cursor and stores your provider / model / API-key settings.

They are a set: the PopClip button hands the selected text plus your option choices to the app over AppleScript, and the app shows the result. Install both.

Requirements: [PopClip](https://pilotmoon.com/popclip/), macOS 13+ (Apple Silicon).

**1. Install the companion app**

Built from source (no notarized release yet):

```bash
cd apps/popclip-window
bash build.sh                              # → dist/LumenTranslation.app
cp -R dist/LumenTranslation.app /Applications/
open /Applications/LumenTranslation.app
```

First launch may be blocked by Gatekeeper (the app isn't signed yet). Right-click the app → **Open** → **Open**, or clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/LumenTranslation.app
```

A menu-bar icon appears — click it → **Settings** to choose a provider, model, and API key.

**2. Install the PopClip extension**

```bash
cd apps/popclip
pnpm build                                 # → dist/Lumen.popclipext
open dist/Lumen.popclipext                 # double-click to install into PopClip
```

Or download `Lumen.popclipextz` from the [latest release](https://github.com/fakechris/lumen-translation/releases/latest) and double-click it.

**3. Use it**

Select text in any macOS app → click **Lumen** in the PopClip bar → the translation appears in the floating window. Switch engine / target language per selection from the PopClip extension's options, or manage everything from the app's **Settings**.

The floating window has a Bob-style language bar at the top: pick the source language (auto-detect by default) or target language, or tap the ⇄ button to swap them — the text re-translates instantly with the new pair (the swap also uses the engine's auto-detected language when the source is on auto-detect).

### Windows desktop app

Windows has no PopClip, so **Lumen Translation for Windows** (`apps/desktop`)
does both jobs: it watches for text selections itself and shows the floating
translation window. One install, no companion extension.

Requirements: Windows 10 20H1 (build 19041) or later, x64. WebView2 is
installed automatically if it's missing.

**1. Install**

The Windows installer is currently an **unsigned development preview**, not a
trusted direct-release artifact. Download
`Lumen-Translation-<version>-windows-x64-setup.exe` and
`SHA256SUMS-windows.txt` from the [latest
release](https://github.com/fakechris/lumen-translation/releases/latest), verify
the SHA-256 value, and optionally verify its signed GitHub provenance with
`gh attestation verify <installer> --repo fakechris/lumen-translation`. Do not
run an artifact that fails either check. The installer is per-user and needs no
administrator prompt; production distribution requires code signing.

Or build it yourself:

```powershell
pnpm install
pnpm -r --filter "./packages/**" build      # engines expose types via ./dist
pnpm --filter @lumen/desktop tauri build --bundles nsis
```

**2. Use it**

Select text in any app → a small **Lumen** bar appears next to the cursor →
click it. The translation opens in a floating window: **Copy**, **Speak**,
**Esc** or **Ctrl+W** to dismiss.

| Shortcut     | Action                                                |
| ------------ | ----------------------------------------------------- |
| `Alt+Ctrl+T` | Translate the current selection without using the bar |
| `Alt+Ctrl+L` | Re-open the last translation                          |

Both are rebindable in **Preferences → Selection**.

Right-click the tray icon for **Engine** (the same quick provider switch as the
macOS menu bar) and **Preferences**, where API keys, models, endpoint region,
languages, and custom OpenAI-compatible endpoints live.

**How it reads your selection**

Lumen asks Windows' accessibility layer (UI Automation) for the selected text.
That path touches nothing else — no clipboard, no synthetic keystrokes — and
works in most apps, including Chromium and Electron ones.

Some apps expose no accessible text. There, Lumen falls back to pressing
Ctrl+C for you and restoring whatever was on the clipboard afterwards. That
fallback only restores _text_, so if you had an image or files copied, they are
lost. Turn it off in **Preferences → Selection** to keep the clipboard strictly
untouched, at the cost of the bar not appearing in those apps.

Password fields are never read and never offered. API keys are encrypted at
rest with DPAPI, tied to your Windows account.

See [`docs/WINDOWS_PORT_STATUS.md`](docs/WINDOWS_PORT_STATUS.md) for the full
list of what is implemented, what is deliberately out of scope, and what still
needs on-device verification.

### Mobile (iOS / Android)

A Capacitor shell (`apps/mobile`) reuses `@lumen/core` + `@lumen/engines`.

```bash
cd apps/mobile
pnpm build
npx cap add ios && npx cap sync ios   # or android
npx cap open ios
```

### Self-hosted sync backend

```bash
cd apps/worker
npx wrangler deploy
# set LUMEN_TOKEN secret, bind LUMEN_KV (Workers KV)
```

Point the extension's sync panel at your Worker URL + token.

---

## Architecture

A pnpm monorepo. Core packages are engine-agnostic and DOM-agnostic so every app reuses them.

```
packages/
  core/        @lumen/core        Engine/Segment/Rule/Settings, batch+concurrency pipeline, dedupe
  engines/     @lumen/engines     Google/Microsoft/DeepL/OpenAI/Ollama + catalog-driven LLM providers, streaming
  dom/         @lumen/dom         Paragraph detection + rich-text-preserving bilingual render
  subtitles/   @lumen/subtitles   SRT/VTT parse, cue merge/split, AI split, video adapter framework
  pdf/         @lumen/pdf         pdf.js extraction + bilingual reflow
  ocr/         @lumen/ocr         Tesseract.js wrapper (lazy WASM) + OCR-and-translate
  sync/        @lumen/sync        WebDAV + Worker backends, 3 merge strategies
  meetings/    @lumen/meetings    Meet/Teams/Zoom caption capture + translator + overlay

apps/
  extension/     @lumen/extension  WXT cross-browser app (Chrome/Edge/Firefox/Safari)
  userscript/    @lumen/userscript Tampermonkey/Violentmonkey build
  popclip/       @lumen/popclip    macOS PopClip extension (esbuild IIFE)
  popclip-window/ LumenTranslation macOS menu-bar companion app (Swift/AppKit floating window)
  desktop/       @lumen/desktop    Windows tray app (Tauri v2) — selection watcher + translation window
  worker/        @lumen/worker     Cloudflare Workers sync backend (Hono + KV)
  mobile/        @lumen/mobile     Capacitor shell (Vite + React)

sites/         Community site-adaptation rules
tools/         Build/icon scripts
```

Heavy dependencies (pdf.js, tesseract.js, jszip) are dynamically imported so they only load when their feature is used.

### Provider catalog (lumen-suite contract)

The LLM provider presets in `@lumen/engines` are no longer hand-maintained. They are derived
from the Lumen product-suite data contract `lumen.provider-catalog/v1`
([fakechris/lumen-suite](https://github.com/fakechris/lumen-suite), `contracts/provider-catalog.v1.json`),
vendored byte-for-byte at `packages/engines/src/provider-catalog.v1.json` and embedded at compile
time via a JSON import. `PROVIDER_CATALOG` in `packages/engines/src/providers.ts` is a filtered
adapter view of that JSON (OpenAI-compatible chat providers), including per-provider
`quirks.no_thinking` data used to disable chain-of-thought output on reasoning models.

- To pull the latest catalog: `pnpm sync:provider-catalog` (never hand-edit the vendored JSON).
- Contract-conformance tests live in `packages/engines/src/__tests__/provider-catalog.test.ts`.

Three hosts read the catalog, each with its own UI policy over the same data:

| Host                   | How it reads the catalog                                                                                        | Curated list                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Extension / userscript | `PROVIDER_CATALOG` from `@lumen/engines`                                                                        | OpenAI-compatible chat, minus `openai`       |
| Windows desktop        | `PROVIDER_CATALOG_SOURCE` from `@lumen/engines`, adapted in `apps/desktop/src/catalog.ts`                       | The curated eight, plus both free MT engines |
| macOS companion        | The same JSON, copied into the app bundle by `build.sh` and decoded by `LumenTranslation/ProviderCatalog.swift` | The curated eight, plus both free MT engines |

The Swift decoder is the one remaining second implementation. It reads the same
vendored file rather than hardcoding provider data, but its curated-list and
alias logic is duplicated from `apps/desktop/src/catalog.ts`; the two are kept
in step by the tests in `apps/desktop/src/__tests__/catalog.test.ts` and
`apps/popclip-window/tests/main.swift`.

---

## Development

Requirements: Node 20+, pnpm 10+.

```bash
pnpm install
pnpm dev              # run the extension in dev mode (Chrome)
pnpm dev:firefox      # Firefox dev
pnpm typecheck        # tsc across all workspaces
pnpm test             # vitest across all workspaces
pnpm build            # build all packages + extension + userscript + popclip
pnpm --filter @lumen/extension zip        # chrome zip
pnpm --filter @lumen/extension zip:firefox
bash apps/popclip-window/build.sh         # macOS companion app (needs macOS + swiftc)
```

The macOS companion app (`apps/popclip-window`) is a Swift/AppKit target built with `swiftc`, not part of the pnpm graph, so build it separately with the script above (macOS 13+, Apple Silicon).

### Windows desktop app

`apps/desktop` is a Tauri v2 app: a Vite/React frontend in the pnpm graph plus
a Rust backend under `src-tauri`. Needs Rust stable and, for a full build,
Windows with the Windows 10/11 SDK.

```bash
pnpm --filter @lumen/desktop typecheck
pnpm --filter @lumen/desktop test              # catalog, settings, fallback chain
pnpm --filter @lumen/desktop tauri dev         # Windows only
pnpm --filter @lumen/desktop tauri build --bundles nsis
node tools/gen-windows-icons.mjs               # regenerate icons from AppIcon.svg
```

The Rust side builds on macOS and Linux too — the Windows-only modules (input
hooks, UI Automation, DPAPI, clipboard) have fail-closed stubs — so
`cargo test`, `cargo clippy` and `cargo fmt` all work from any workstation:

```bash
cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets
```

The Windows-only code paths are compiled for real by `ci-windows.yml`, which
also produces the NSIS installer and the Microsoft Store MSIX
(`scripts/windows/build-msix.ps1`).

Releasing: push a `v*` tag. The `release.yml` workflow builds every artifact and attaches them to a GitHub Release.

```bash
git tag v0.2.0 && git push origin v0.2.0
```

---

## Milestones

Status as of `v0.1.0`.

### v0.1.0 — Phase 1 MVP + Phase 2/3 frameworks ✅ Shipped

- [x] Web bilingual + translation-only mode, rich-text preservation
- [x] Selection, hover, input-box, floating-ball translation
- [x] Context menus + keyboard shortcuts
- [x] 5 base engines (Google, Microsoft, DeepL, OpenAI, Ollama) + 13 LLM providers
- [x] Streaming AI, batch+concurrency, dedupe, AI glossary
- [x] Per-site rules + rule subscriptions
- [x] en/zh UI, 4 translation style variants
- [x] Chrome MV3 + Firefox MV2 + userscript + PopClip builds
- [x] Video subtitles: YouTube, Bilibili, Netflix, Prime Video, Vimeo (+ generic adapter)
- [x] Meeting captions: Meet, Teams, Zoom
- [x] PDF bilingual reflow + scanned-PDF OCR
- [x] File translator: TXT, Markdown, HTML, ePub
- [x] Image OCR translation
- [x] Cross-device sync: WebDAV + self-hosted Worker
- [x] Mobile shell (Capacitor) reusing core/engines
- [x] Safari build scripts (need macOS + Xcode to produce the Xcode project)
- [x] CI (typecheck/test/build) + Release pipeline (tag-triggered)

### v0.2.0 — Depth & coverage (planned)

- [ ] PDF original-layout preservation (currently reflow, not overlay)
- [ ] Manga / webtoon panel segmentation + text-region inpainting (framework reuses image translator; auto panel detection pending)
- [ ] 100+ video platforms via community `VideoPlatformAdapter` packs
- [ ] Chrome BuiltinAI / Translator API adapter (runtime capability detection)
- [ ] Thunderbird support
- [ ] Glossary import/export (CSV/JSON)

### v0.3.0 — Native mobile & Safari (planned)

- [ ] Native iOS app via Capacitor (App Store), with camera OCR
- [ ] Native Android app, with in-app webview bilingual translation
- [ ] Notarized Safari extension build & distribution
- [ ] iOS Userscripts / Orion support

### v0.4.0 — Extensibility (planned)

- [ ] Plugin/hook system: `beforeTranslate` / `segment` / `merge` / `render` / `afterTranslate` lifecycle hooks
- [ ] Cloud OCR adapter hook (in addition to local Tesseract.js)
- [ ] Custom engine templates UI (request/response shaping without code)
- [ ] Community rule marketplace (browse + one-click subscribe)

### v1.0.0 — Stability (planned)

- [ ] Public API freeze for `@lumen/core`, `@lumen/engines`, `@lumen/dom`, `@lumen/sync`
- [ ] Documentation site (Astro)
- [ ] Playwright E2E across Chrome/Firefox/Safari
- [ ] Localization: add ja/ko UI

---

## Privacy

- Extension settings, rules, and history are stored locally via
  `browser.storage.local` (with a `localStorage` fallback in non-extension
  environments). The Windows desktop app stores settings under
  `%APPDATA%\app.lumen.translation`; API-key values are DPAPI-encrypted for the
  current Windows user, while the remaining preferences are local JSON.
- AI calls go directly from your device to the engine provider using **your own API key**. Lumen never proxies your traffic.
- The sync backend is **yours** (your WebDAV server or your Cloudflare Worker). No Lumen-operated cloud sees your data.
- No telemetry, no analytics, no advertising, no acquisition path. Ever.

---

## License

Apache-2.0. See [LICENSE](./LICENSE). Safe for commercial derivative use, cloud integration, and closed-source forks.

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

## Table of contents

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

The file-translator page handles plain-text and e-book formats with bilingual output and download:

- **TXT**
- **Markdown** (bilingual render, structure preserved)
- **HTML** (DOM-aware bilingual serialization)
- **ePub** (unzipped via jszip, OPF spine walked, each chapter bilingual-rendered and re-packed)

### Image translation

- The image-translator page dynamically loads Tesseract.js, OCRs the uploaded image, auto-detects the OCR language from the target language (`zh` → `chi_sim+eng`, `ja` → `jpn`, etc.), translates, and shows the result.
- An `inpaintImage` placeholder is provided for future text-region masking.

### Cross-device sync

- **WebDAV** backend (any WebDAV server: Nextcloud,坚果云, Synology, etc.).
- **Self-hosted Worker** backend (`apps/worker`, Cloudflare Workers + KV, Bearer auth, `/health` + `/snapshot` GET/PUT).
- Three merge strategies (`merge-rules`, `merge-settings`, full overwrite) via `syncOnce`.
- Configure and test connection from the options sync panel.

### Internationalization

- UI in **English** and **中文**, auto-detected from browser language.
- Per-engine model dropdowns, region selectors (domestic/overseas), and "get API key" docs links.

### External event API

Other tools can drive Lumen via a `window` `CustomEvent` named `lumen`:

```js
window.dispatchEvent(new CustomEvent("lumen", { detail: { action: "toggle_translate" } }));
// actions: toggle_translate | translate_selection | translate_input
```

---

## Translation engines

Engines are grouped in the options UI. All LLM engines are OpenAI-compatible and accept your own API key.

| Group | Engines |
|---|---|
| **Free (no key)** | Google Translate, Microsoft Translator |
| **Classic MT** | DeepL (Free/Pro) |
| **LLM · China** | DeepSeek 深度求索, GLM 智谱 BigModel, Kimi 月之暗面, MiniMax 海螺, 豆包 字节火山 Ark, 通义千问 阿里 DashScope, 腾讯混元 Hunyuan, 百度文心 ERNIE, 讯飞星火 Spark, 百川 Baichuan, 零一万物 Yi, 硅基流动 SiliconFlow |
| **LLM · Overseas** | OpenRouter (aggregator, 100+ models) |
| **Local / Custom** | Ollama (local), OpenAI-compatible custom endpoint |

LLM features:

- **Streaming output** (SSE parser) for all OpenAI-compatible engines.
- **Batch + concurrency control** with segment deduplication (`dedupeSegments`) so identical sentences are translated once.
- **AI glossary / terminology dictionary** passed to every LLM request.
- **MiniMax & SiliconFlow region toggle** (domestic / overseas endpoint).
- **Model presets** per provider with a custom-model fallback.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+Q` | Translate / clear current page |
| `Alt+S` | Translate selection |
| `Alt+K` | Open popup |
| `Alt+Hover` | Translate hovered block |

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

### macOS PopClip

1. Download `Lumen.popclipextz` (or the `Lumen.popclipext` folder).
2. Double-click to install.
3. Select text in any macOS app → Lumen appears in the PopClip bar with **show** / **copy** / **paste** actions.

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
  engines/     @lumen/engines     Google/Microsoft/DeepL/OpenAI/Ollama + 13 LLM providers, streaming
  dom/         @lumen/dom         Paragraph detection + rich-text-preserving bilingual render
  subtitles/   @lumen/subtitles   SRT/VTT parse, cue merge/split, AI split, video adapter framework
  pdf/         @lumen/pdf         pdf.js extraction + bilingual reflow
  ocr/         @lumen/ocr         Tesseract.js wrapper (lazy WASM) + OCR-and-translate
  sync/        @lumen/sync        WebDAV + Worker backends, 3 merge strategies
  meetings/    @lumen/meetings    Meet/Teams/Zoom caption capture + translator + overlay

apps/
  extension/   @lumen/extension   WXT cross-browser app (Chrome/Edge/Firefox/Safari)
  userscript/  @lumen/userscript  Tampermonkey/Violentmonkey build
  popclip/     @lumen/popclip     macOS PopClip extension (esbuild IIFE)
  worker/      @lumen/worker      Cloudflare Workers sync backend (Hono + KV)
  mobile/      @lumen/mobile      Capacitor shell (Vite + React)

sites/         Community site-adaptation rules
tools/         Build/icon scripts
```

Heavy dependencies (pdf.js, tesseract.js, jszip) are dynamically imported so they only load when their feature is used.

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
```

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

- All settings, rules, and history are stored locally (`browser.storage` / IndexedDB).
- AI calls go directly from your device to the engine provider using **your own API key**. Lumen never proxies your traffic.
- The sync backend is **yours** (your WebDAV server or your Cloudflare Worker). No Lumen-operated cloud sees your data.
- No telemetry, no analytics, no advertising, no acquisition path. Ever.

---

## License

Apache-2.0. See [LICENSE](./LICENSE). Safe for commercial derivative use, cloud integration, and closed-source forks.

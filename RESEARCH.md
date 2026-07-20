# Lumen Translation — Technical Design

> Design notes, technology choices, and roadmap for the Lumen Translation product matrix.

---

## 1. Goals

Build a complete open-source bilingual translation product matrix under a permissive license:

- **Everywhere you read, write, watch, or meet** — web pages, PDFs, e-books, video subtitles, live meeting captions, images, and input fields.
- **Every platform** — browser extension (Chrome/Edge/Firefox/Safari), userscript, macOS PopClip, mobile, and a self-hostable sync backend.
- **Every engine** — free MT, classic MT, LLM providers (domestic and overseas), and local models, all swappable.
- **Privacy-first** — local storage, user-owned API keys, no proxy, no telemetry.
- **Composable** — the core is published as independent npm packages so any other product (Electron, Webview, mobile, server) can embed it.

---

## 2. Design principles

1. **Permissive license** — Apache-2.0, safe for commercial derivative use and cloud integration.
2. **Privacy first** — settings stored locally; AI calls use the user's own keys; no built-in proxy.
3. **Composable core** — engine-agnostic, DOM-agnostic packages that are independently importable.
4. **Lazy heavy deps** — pdf.js, tesseract.js, jszip are dynamically imported so they only load when their feature is used.
5. **No telemetry, no ads, no acquisition path** — explicitly community-owned.

---

## 3. Technology choices

| Layer | Choice | Rationale |
|---|---|---|
| Extension framework | **WXT** | Unified Chrome/Edge/Firefox/Safari build with a Safari module; modern Vite-based toolchain. |
| Language | **TypeScript** (strict) | Type safety across a multi-package monorepo; strong ecosystem. |
| UI framework | **React 19 + Tailwind CSS v4** | Largest contributor pool; low community-contribution friction. |
| State | **Zustand** | Lightweight, no boilerplate; fits the settings/options store. |
| Storage | `browser.storage.local` (with a `localStorage` fallback in non-extension environments) | Config via the browser extension storage API; a localStorage fallback supports non-extension environments. |
| Content-script DOM | Native + `MutationObserver` queue | Paragraph smart detection is the core; keep it dependency-free. |
| PDF | **pdf.js** + self-built bilingual layout layer | Reflow bilingual output preserving reading order. |
| Subtitles | Self-built cue merge/split + AI re-segmentation | YouTube via `ytInitialPlayerResponse`/`timedtext`; pluggable per-platform adapters. |
| OCR | **Tesseract.js** (local, lazy WASM) | Privacy-first; runs in-browser; cloud OCR hook planned. |
| Sync backend | **Cloudflare Workers** (Hono + KV) + **WebDAV** adapter | Self-hostable first; no Lumen-operated cloud. |
| Build / monorepo | WXT Vite + **pnpm** workspaces | Fast, monorepo-friendly, frozen-lockfile CI. |
| Tests | **Vitest** | Unit tests across all workspaces; E2E (Playwright) planned for v1.0. |
| i18n | Built-in `en`/`zh` dictionaries + `_locales` | Browser-native `__MSG_*__` for manifest strings. |
| CI/CD | GitHub Actions | PR verification + tag-triggered multi-artifact release. |

---

## 4. Architecture & data flow

### Monorepo layout

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

### Translation pipeline

```
DOM → detectParagraphs() → paragraphsToSegments()
     → dedupeSegments()            # identical sentences translated once
     → engine.translateAll({       # batch + concurrency control
         pair, segments, glossary
       })
     → restore()                   # re-expand deduped segments
     → renderBilingual()           # rich-text-preserving side-by-side
```

Every engine implements the same `Engine` interface (`translateAll`, optional `translateStream`), so the pipeline is engine-agnostic. LLM engines are thin OpenAI-compatible wrappers over `createOpenAIEngine` with provider presets (endpoint, default model, region, docs).

### App reuse

The extension, userscript, PopClip, mobile, and worker all import `@lumen/core` + `@lumen/engines`. The DOM-bound packages (`@lumen/dom`, `@lumen/subtitles`, `@lumen/meetings`) are used only where a DOM exists; the mobile and worker shells use the DOM-agnostic core.

---

## 5. Roadmap

See [README.md § Milestones](./README.md#milestones) for the canonical, checkbox-tracked plan. Phase summary:

- **v0.1.0 (shipped)** — Phase 1 MVP + Phase 2/3 frameworks: web bilingual, in-page actions, 5 base engines + 13 LLM providers, video subtitles (6 platforms), meeting captions (3 platforms), PDF, file translator (4 formats), image OCR, sync, rule subscriptions, PopClip, userscript, mobile shell, Safari scripts, CI + release pipeline.
- **v0.2.0 (planned)** — Depth & coverage: PDF original-layout, manga/webtoon segmentation, 100+ video platforms, Chrome BuiltinAI, Thunderbird, glossary import/export.
- **v0.3.0 (planned)** — Native mobile & Safari: iOS/Android apps, notarized Safari build, Orion support.
- **v0.4.0 (planned)** — Extensibility: lifecycle hook system, cloud OCR hook, custom engine templates UI, community rule marketplace.
- **v1.0.0 (planned)** — Stability: public API freeze, docs site, Playwright E2E, ja/ko UI.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| PDF original-layout preservation is a large engineering effort | Ship reflow bilingual first (done in v0.1.0), add overlay-preserved layout in v0.2.0. |
| 100+ video platforms each have different subtitle mechanisms | Community `VideoPlatformAdapter` packs; the core ships 6 platforms + a generic fallback. |
| All code must be written from scratch (no third-party source copied in) | Behavior-level design only; architecture and code written independently. |
| Browser AI APIs (Chrome BuiltinAI / Translator API) are inconsistent | Abstract behind an `Engine` adapter with runtime capability detection (v0.2.0). |
| Heavy deps bloat the extension | pdf.js, tesseract.js, jszip are dynamically imported and only load on feature use. |

---

## 7. License

**Apache-2.0** — chosen over MIT for its explicit patent grant, which is friendlier to enterprise and cloud integration. Allows commercial derivative use, closed-source forks, and integration into larger products. See [LICENSE](./LICENSE).

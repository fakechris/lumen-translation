# Lumen Translation

> Open-source, Apache-2.0 bilingual translation product matrix — a permissive-licensed alternative to FluentRead, Kiss Translator, and Immersive Translate.

Status: early development (Phase 1 MVP).

## Packages

- `packages/core` — translation engine abstractions (`Translator`, `Engine`, `Rule`, `Segment`)
- `packages/engines` — Google, Microsoft, DeepL, OpenAI, Ollama + 12 built-in LLM providers (DeepSeek, GLM, Kimi, MiniMax, Doubao, Qwen, Hunyuan, ERNIE, Spark, Baichuan, Yi, SiliconFlow, OpenRouter)
- `packages/dom` — paragraph detection and bilingual rendering
- `packages/subtitles` — SRT/VTT parse, cue merge/split, AI split, video platform adapter framework
- `packages/pdf` — pdf.js text extraction + bilingual reflow
- `packages/ocr` — Tesseract.js wrapper (lazy-loaded) for image / scanned-PDF OCR
- `packages/sync` — WebDAV + self-hosted worker sync
- `packages/meetings` — Google Meet / Teams / Zoom live caption capture + translate
- `apps/extension` — WXT cross-browser extension (Chrome / Edge / Firefox / Safari)
- `apps/userscript` — Tampermonkey/Violentmonkey userscript fallback
- `apps/popclip` — macOS PopClip extension (translate selection from the PopClip bar)
- `apps/worker` — self-hostable Cloudflare Worker sync backend
- `apps/mobile` — Capacitor mobile shell (reuses core/engines on iOS/Android)
- `sites` — community site adaptation rules

## Principles

1. **Permissive license** — Apache-2.0, safe for commercial derivative use.
2. **Privacy first** — all settings stored locally; AI calls use the user's own keys; no built-in proxy.
3. **Composable** — core packages are independently importable npm packages.
4. **No telemetry, no ads, no acquisition path** — explicitly community-owned.

## Development

```bash
pnpm install
pnpm dev      # run the extension in dev mode (Chrome)
pnpm build    # build all packages and apps
pnpm test
```

See `RESEARCH.md` for the full competitive analysis and roadmap.

## License

Apache-2.0. See [LICENSE](./LICENSE).

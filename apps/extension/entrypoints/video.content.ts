import { translateAll, dedupeSegments, type Segment } from "@lumen/core";
import { readSettings } from "../src/store";
import { buildEngine } from "../src/engines";
import "../src/styles.css";

/**
 * Lumen video subtitle translator.
 *
 * Matches the major video platforms and renders bilingual captions by
 * observing each platform's caption DOM and translating new caption text on
 * the fly (with a per-text cache so repeated lines don't re-hit the engine).
 *
 * A small toggle button is overlaid on the page; subtitles translate only when
 * the user enables it (so we never call an engine without consent).
 */

interface Platform {
  id: string;
  hostPattern: RegExp;
  /** Candidate selectors for the caption text container, tried in order. */
  captionSelectors: string[];
  /** How to attach the translation line relative to the caption element. */
  attach: "below" | "after";
}

const PLATFORMS: Platform[] = [
  {
    id: "youtube",
    hostPattern: /(^|\.)youtube\.com$/,
    captionSelectors: [".ytp-caption-segment", ".caption-visual-line"],
    attach: "below",
  },
  {
    id: "bilibili",
    hostPattern: /(^|\.)bilibili\.com$/,
    captionSelectors: [".bpx-player-subtitle-panel-text", ".bilibili-player-video-subtitle"],
    attach: "below",
  },
  {
    id: "netflix",
    hostPattern: /(^|\.)netflix\.com$/,
    captionSelectors: [".player-timedtext-text-container span"],
    attach: "below",
  },
  {
    id: "primevideo",
    hostPattern: /(^|\.)primevideo\.com$/,
    captionSelectors: [".atvwebplayersdk-captions-text"],
    attach: "below",
  },
  {
    id: "vimeo",
    hostPattern: /(^|\.)vimeo\.com$/,
    captionSelectors: [".vp-cues > .vp-cue"],
    attach: "below",
  },
  {
    id: "generic",
    hostPattern: /.*/,
    captionSelectors: ['[class*="caption" i]', '[class*="subtitle" i]'],
    attach: "below",
  },
];

export default defineContentScript({
  matches: [
    "https://*.youtube.com/*",
    "https://*.bilibili.com/*",
    "https://*.netflix.com/*",
    "https://*.primevideo.com/*",
    "https://*.vimeo.com/*",
  ],
  runAt: "document_idle",
  allFrames: false,
  cssInjectionMode: "manifest",
  async main() {
    const found = PLATFORMS.find((p) => p.hostPattern.test(location.hostname));
    if (!found) return;
    const platform = found;

    let settings = await readSettings();
    let engine = buildEngine(settings);
    let enabled = false;
    const cache = new Map<string, string>();
    let translating: Promise<void> | null = null;

    // ---------- toggle button ----------
    const btn = document.createElement("button");
    btn.textContent = "Lumen 字幕";
    btn.className = "lumen-video-toggle";
    btn.style.cssText =
      "position:fixed;right:16px;top:80px;z-index:2147483647;" +
      "background:rgba(37,99,235,.9);color:#fff;border:none;border-radius:18px;" +
      "padding:6px 14px;font:12px/1 system-ui;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);";
    btn.addEventListener("click", toggle);
    document.documentElement.appendChild(btn);

    function setActive(active: boolean) {
      enabled = active;
      btn.style.background = active ? "rgba(22,163,74,.9)" : "rgba(37,99,235,.9)";
      btn.textContent = active ? "Lumen 字幕 ON" : "Lumen 字幕";
      if (!active) clearAllTranslations();
    }

    function toggle() {
      setActive(!enabled);
      if (enabled) scheduleScan();
    }

    // ---------- translation ----------
    async function translateText(text: string): Promise<string> {
      const key = text;
      if (cache.has(key)) return cache.get(key)!;
      const seg: Segment = { id: "v", text };
      const { unique, restore } = dedupeSegments([seg]);
      try {
        const r = await translateAll(
          engine,
          {
            pair: { source: settings.sourceLang, target: settings.targetLang },
            segments: unique,
            glossary: settings.glossary,
          },
          { concurrency: 4, maxBatchSize: 16 },
        );
        const out = restore(r.segments)[0]?.text ?? text;
        cache.set(key, out);
        return out;
      } catch (err) {
        return `[${(err as Error).message}]`;
      }
    }

    function findCaptionEls(): Element[] {
      for (const sel of platform.captionSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) return Array.from(els);
      }
      return [];
    }

    function clearAllTranslations() {
      document
        .querySelectorAll(".lumen-video-translation")
        .forEach((n) => n.remove());
    }

    async function scan() {
      if (!enabled) return;
      const els = findCaptionEls();
      for (const el of els) {
        const text = (el.textContent ?? "").trim();
        if (!text) continue;
        if (el.parentElement?.querySelector(".lumen-video-translation")) continue;
        const line = document.createElement("div");
        line.className = "lumen-video-translation";
        line.style.cssText =
          "color:#93c5fd;font-weight:500;margin-top:2px;text-align:center;" +
          "text-shadow:0 0 4px rgba(0,0,0,.9);pointer-events:none;";
        line.textContent = "…";
        if (platform.attach === "below" && el.parentElement) {
          el.parentElement.appendChild(line);
        } else {
          el.insertAdjacentElement("afterend", line);
        }
        const translated = await translateText(text);
        if (line.isConnected) line.textContent = translated;
      }
    }

    function scheduleScan() {
      if (translating) return;
      translating = scan().finally(() => {
        translating = null;
      });
    }

    // ---------- observer ----------
    const observer = new MutationObserver(() => {
      if (enabled) scheduleScan();
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });

    // Listen for settings updates from the options page.
    (browser.runtime?.onMessage as { addListener?: (cb: (msg: unknown) => void) => void } | undefined)
      ?.addListener?.((msg) => {
        const m = msg as { type?: string; settings?: typeof settings };
        if (m?.type === "settings-broadcast" && m.settings) {
          settings = m.settings;
          engine = buildEngine(settings);
          cache.clear();
        }
      });
  },
});

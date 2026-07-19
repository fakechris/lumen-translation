import { pickAdapter, createCaptionTranslator, createCaptionOverlay } from "@lumen/meetings";
import { readSettings } from "../src/store";
import { buildEngine } from "../src/engines";
import "../src/styles.css";

/**
 * Lumen meeting caption translator. Detects Google Meet / Teams / Zoom web
 * clients, captures their live captions, and renders a bilingual overlay at
 * the bottom of the screen. A floating toggle enables translation on demand.
 */

export default defineContentScript({
  matches: [
    "https://meet.google.com/*",
    "https://teams.microsoft.com/*",
    "https://teams.live.com/*",
    "https://*.zoom.us/*",
  ],
  runAt: "document_idle",
  allFrames: false,
  cssInjectionMode: "manifest",
  async main() {
    const found = pickAdapter(location.href);
    if (!found) return;
    const adapter = found;

    let settings = await readSettings();
    let engine = buildEngine(settings);
    let active = false;
    let overlay: ReturnType<typeof createCaptionOverlay> | null = null;
    let translator: ReturnType<typeof createCaptionTranslator> | null = null;

    const btn = document.createElement("button");
    btn.textContent = "Lumen 会议字幕";
    btn.style.cssText =
      "position:fixed;right:16px;top:16px;z-index:2147483647;" +
      "background:rgba(37,99,235,.9);color:#fff;border:none;border-radius:18px;" +
      "padding:8px 14px;font:12px/1 system-ui;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);";
    btn.addEventListener("click", toggle);
    document.documentElement.appendChild(btn);

    function setActive(on: boolean) {
      active = on;
      btn.style.background = on ? "rgba(22,163,74,.9)" : "rgba(37,99,235,.9)";
      btn.textContent = on ? "Lumen 会议字幕 ON（点击关闭）" : "Lumen 会议字幕";
      if (on) {
        overlay = createCaptionOverlay();
        translator = createCaptionTranslator(
          engine,
          { source: settings.sourceLang, target: settings.targetLang },
          { debounceMs: 400 },
        );
        adapter.start(async (caption) => {
          if (!translator || !overlay) return;
          const translated = await translator.translate(caption);
          overlay.push(caption.text, translated, caption.speaker);
        });
      } else {
        adapter.stop();
        translator?.dispose();
        overlay?.el.remove();
        overlay = null;
        translator = null;
      }
    }

    function toggle() {
      setActive(!active);
    }

    (browser.runtime?.onMessage as { addListener?: (cb: (msg: unknown) => void) => void } | undefined)
      ?.addListener?.((msg) => {
        const m = msg as { type?: string; settings?: typeof settings };
        if (m?.type === "settings-broadcast" && m.settings) {
          settings = m.settings;
          engine = buildEngine(settings);
          // Re-create translator with new engine if active.
          if (active) {
            translator?.dispose();
            translator = createCaptionTranslator(
              engine,
              { source: settings.sourceLang, target: settings.targetLang },
              { debounceMs: 400 },
            );
          }
        }
      });
  },
});

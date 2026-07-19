import type { CaptionAdapter } from "../captions.js";

/** Zoom (web client) caption adapter. Zoom's web captions render in a panel. */
export function createZoomAdapter(): CaptionAdapter {
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastText = "";
  let counter = 0;

  const SELECTORS = [
    ".closed-caption__text",
    '[aria-label*="caption" i]',
    ".live-transcription",
  ];

  function findContainer(): Element | null {
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  return {
    id: "zoom-web",
    detect(url) {
      return /^https:\/\/.*\.zoom\.us\//.test(url);
    },
    start(onCaption) {
      const tick = () => {
        const el = findContainer();
        if (!el) return;
        const text = (el.textContent ?? "").trim();
        if (!text || text === lastText) return;
        lastText = text;
        onCaption({ id: ++counter, text, ts: Date.now() });
      };
      timer = setInterval(tick, 300);
      observer = new MutationObserver(() => tick());
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    },
    stop() {
      if (timer) clearInterval(timer);
      observer?.disconnect();
      observer = null;
      timer = null;
      lastText = "";
    },
  };
}

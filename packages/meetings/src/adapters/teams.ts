import type { CaptionAdapter } from "../captions.js";

/** Microsoft Teams (web) caption adapter. Teams web shows captions in a region. */
export function createTeamsAdapter(): CaptionAdapter {
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastText = "";
  let counter = 0;

  const SELECTORS = [
    "[data-tid='live-caption-region']",
    ".live-caption-region",
    'div[role="region"][aria-label*="caption" i]',
  ];

  function findContainer(): Element | null {
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  return {
    id: "microsoft-teams",
    detect(url) {
      return /https:\/\/teams\.(microsoft|live)\.com\//.test(url);
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

import type { CaptionAdapter } from "../captions.js";

/**
 * Google Meet caption adapter. Meet renders live captions in a
 * `.a4cQT .ZV4Nfd` container (class names change over time; we also fall back
 * to a broader selector). We poll the container and emit a caption whenever its
 * text grows, debounced by the translator downstream.
 */
export function createGoogleMeetAdapter(): CaptionAdapter {
  let observer: MutationObserver | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastText = "";
  let counter = 0;

  const SELECTORS = [
    ".a4cQT .ZV4Nfd",
    "[data-live-caption]",
    ".NsXUc .a4cQT",
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
    id: "google-meet",
    detect(url) {
      return /^https:\/\/meet\.google\.com\//.test(url);
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
      timer = setInterval(tick, 250);
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

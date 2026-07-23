// Lumen Translation userscript entry.
// Reuses @lumen/core, @lumen/engines, @lumen/dom. Provides a minimal subset:
//   - Alt+Q  toggle page translation
//   - Alt+S  translate selection
//   - floating ball toggle
// Settings are stored via GM_getValue/GM_setValue. Users must edit the script
// header (or the SETTINGS constant below) to configure engines that need keys.

import {
  translateAll,
  dedupeSegments,
  type Engine,
  type Segment,
  type Settings,
  DEFAULT_SETTINGS,
} from "@lumen/core";
import {
  detectParagraphs,
  paragraphsToSegments,
  renderBilingual,
  clearBilingual,
} from "@lumen/dom";
import { createGoogleEngine } from "@lumen/engines";

interface UserscriptSettings extends Settings {}

function loadSettings(): UserscriptSettings {
  const stored = typeof GM_getValue === "function"
    ? GM_getValue<Partial<Settings>>("lumen-settings", {})
    : {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

function saveSettings(s: UserscriptSettings) {
  if (typeof GM_setValue === "function") GM_setValue("lumen-settings", s);
}

function buildEngine(_settings: UserscriptSettings): Engine {
  // Userscript keeps it simple: free Google by default. Users who want AI
  // engines should install the extension build instead.
  return createGoogleEngine();
}

let settings = loadSettings();
let engine = buildEngine(settings);
let translated = false;

async function translatePage() {
  const paragraphs = detectParagraphs({ minTextLength: 2 });
  if (paragraphs.length === 0) return;
  const segments = paragraphsToSegments(paragraphs);
  const { unique, restore } = dedupeSegments(segments);
  const result = await translateAll(
    engine,
    {
      pair: { source: settings.sourceLang, target: settings.targetLang },
      segments: unique,
    },
    { concurrency: settings.concurrency, maxBatchSize: settings.maxBatchSize },
  );
  const out = restore(result.segments);
  const byId = new Map(out.map((s) => [s.id, s.text]));
  renderBilingual(
    paragraphs.map((p) => ({
      id: p.id,
      text: byId.get(p.id) ?? p.text,
      original: p.node,
      inline: p.inline,
      hideOriginal: !settings.bilingual,
    })),
  );
  translated = true;
  setFabActive(true);
}

function toggle() {
  if (translated) {
    clearBilingual();
    translated = false;
    setFabActive(false);
  } else {
    void translatePage();
  }
}

async function translateSelection() {
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (!text) return;
  const seg: Segment = { id: "sel", text };
  const { unique, restore } = dedupeSegments([seg]);
  const r = await translateAll(
    engine,
    { pair: { source: settings.sourceLang, target: settings.targetLang }, segments: unique },
  );
  const out = restore(r.segments);
  alert(out[0]?.text ?? text);
}

// Inject minimal styles (Lumen Design System "Atelier" palette).
const style = document.createElement("style");
style.textContent = `
lumen-translation{display:block;margin-top:6px;padding:4px 12px;border-left:3px solid #9f4f24;background:#f4dfd2;border-radius:4px;font:inherit;color:inherit;transition:background .18s}
lumen-translation:hover{background:rgba(159,79,36,.18)}
.lumen-fab{position:fixed;right:20px;bottom:20px;width:48px;height:48px;border-radius:50%;background:#9f4f24;color:#fffdfa;font-size:20px;font-weight:700;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 16px 48px rgba(31,26,23,.12);z-index:2147483646;border:none;transition:opacity 120ms}
.lumen-fab:hover{opacity:.88}
.lumen-fab[data-active="true"]{background:#2f7d52}
`;
document.documentElement.appendChild(style);

const fab = document.createElement("button");
fab.className = "lumen-fab";
fab.textContent = "L";
fab.title = "Lumen Translation (Alt+Q)";
fab.addEventListener("click", toggle);
document.documentElement.appendChild(fab);

function setFabActive(active: boolean) {
  fab.setAttribute("data-active", String(active));
}

document.addEventListener("keydown", (e) => {
  if (e.altKey && (e.key === "q" || e.key === "Q")) {
    e.preventDefault();
    toggle();
  } else if (e.altKey && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    void translateSelection();
  }
});

// Expose for debugging / external triggers.
(window as unknown as { lumen: { toggle: typeof toggle; settings: UserscriptSettings } }).lumen = {
  toggle,
  settings,
};

saveSettings(settings);

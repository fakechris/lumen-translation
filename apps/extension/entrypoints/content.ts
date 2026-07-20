import { translateAll, dedupeSegments, escapeHtml, type Engine, type Settings, type Segment } from "@lumen/core";
import {
  detectParagraphs,
  paragraphsToSegments,
  renderBilingual,
  clearBilingual,
  renderTranslatedFragment,
  type DetectedParagraph,
} from "@lumen/dom";
import { readSettings } from "../src/store";
import { buildEngine } from "../src/engines";
import "../src/styles.css";

/**
 * Lumen content script — orchestrates page translation, selection translation,
 * hover translation, input-box translation, and the floating control ball.
 *
 * Messages from the background:
 *   { type: "command", command: "toggle-translate" | "translate-selection" | ... }
 *   { type: "toggle-translate" | "translate-selection" | "translate-input" }
 *   { type: "settings-broadcast", settings }
 */

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",
  allFrames: false,
  cssInjectionMode: "manifest",
  async main(ctx) {
    let settings = await readSettings();
    let engine: Engine = buildEngine(settings);
    let translated = false;
    let busy = false;
    // Dynamic-content tracking: MutationObserver + SPA route hooks re-translate
    // newly inserted / route-changed content without re-hitting already-rendered
    // paragraphs.
    let pageObserver: MutationObserver | null = null;
    let rescanTimer: number | null = null;
    let routeTimer: number | null = null;
    let processedNodes = new Set<Element>();
    // If a route change fires while a translate/rescan is in flight (busy),
    // we defer the route re-translate until the in-flight work releases `busy`.
    // `routePending` is a single boolean, so multiple route changes during one
    // in-flight operation coalesce into one re-run — no infinite loops.
    let routePending = false;
    // ---------- helpers ----------
    const refreshSettings = async (next?: Settings) => {
      settings = next ?? await readSettings();
      engine = buildEngine(settings);
      if (translated) {
        clearBilingual();
        translated = false;
        await translatePage();
      }
    };

    const collectParagraphs = (): DetectedParagraph[] =>
      detectParagraphs({
        rule: matchRuleForUrl(location.href, settings),
        minTextLength: 2,
      });

    const translateSegments = async (segments: Segment[]) => {
      const { unique, restore } = dedupeSegments(segments);
      const result = await translateAll(
        engine,
        {
          pair: { source: settings.sourceLang, target: settings.targetLang },
          segments: unique,
          glossary: settings.glossary,
        },
        { concurrency: settings.concurrency, maxBatchSize: settings.maxBatchSize },
      );
      return restore(result.segments);
    };

    // ---------- dynamic content: observer + SPA route hooks ----------
    function scheduleRescan() {
      if (rescanTimer) window.clearTimeout(rescanTimer);
      rescanTimer = window.setTimeout(() => void rescanNewParagraphs(), 300);
    }

    async function rescanNewParagraphs() {
      if (!translated || busy) return;
      busy = true;
      try {
        const all = collectParagraphs();
        const fresh = all.filter((p) => !processedNodes.has(p.node));
        if (fresh.length === 0) return;
        const segments = paragraphsToSegments(fresh);
        const translatedSegs = await translateSegments(segments);
        const byId = new Map(translatedSegs.map((s) => [s.id, s.text]));
        renderBilingual(
          fresh.map((p) => ({
            id: p.id,
            text: byId.get(p.id) ?? p.text,
            original: p.node,
            inline: p.inline,
            hideOriginal: !settings.bilingual,
            style: settings.style,
          })),
        );
        for (const p of fresh) processedNodes.add(p.node);
      } catch (err) {
        showToast(`Lumen: ${(err as Error).message}`);
      } finally {
        busy = false;
        // If a route change was deferred while we were busy, re-run it now.
        maybeFlushRoutePending();
      }
    }

    function startPageObserver() {
      if (pageObserver) return;
      pageObserver = new MutationObserver(() => scheduleRescan());
      pageObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    function stopPageObserver() {
      pageObserver?.disconnect();
      pageObserver = null;
      if (rescanTimer) window.clearTimeout(rescanTimer);
      rescanTimer = null;
    }

    // SPA route changes: wrap history methods + listen for popstate. On route
    // change the whole page typically re-renders, so we debounce a full
    // re-translation (clear stale wrappers + reset processed set). If a route
    // change fires while a translate/rescan is in flight, we defer the
    // re-translate via `routePending` and flush it when the in-flight work
    // finishes (see maybeFlushRoutePending).
    function onRouteChange() {
      if (!translated) return;
      if (routeTimer) window.clearTimeout(routeTimer);
      routeTimer = window.setTimeout(() => {
        routeTimer = null;
        if (busy) {
          // Defer: the in-flight translate/rescan will call
          // maybeFlushRoutePending from its `finally` and re-run runRouteChange.
          routePending = true;
          return;
        }
        void runRouteChange();
      }, 400);
    }

    async function runRouteChange() {
      clearBilingual();
      translated = false;
      processedNodes.clear();
      await translatePage();
    }

    function maybeFlushRoutePending() {
      if (!routePending) return;
      routePending = false;
      void runRouteChange();
    }

    function patchHistory() {
      for (const key of ["pushState", "replaceState"] as const) {
        const orig = history[key] as (...args: unknown[]) => void;
        history[key] = function (...args: unknown[]) {
          const r = orig.apply(this, args);
          onRouteChange();
          return r as unknown;
        };
      }
      window.addEventListener("popstate", onRouteChange);
    }

    function unpatchHistory() {
      // Best-effort restore; leaving patched is harmless because onRouteChange
      // is a no-op when translation is off.
      window.removeEventListener("popstate", onRouteChange);
    }

    // ---------- page translation ----------
    async function translatePage() {
      if (busy) return;
      busy = true;
      try {
        const paragraphs = collectParagraphs();
        if (paragraphs.length === 0) return;
        const segments = paragraphsToSegments(paragraphs);
        const translatedSegs = await translateSegments(segments);
        const byId = new Map(translatedSegs.map((s) => [s.id, s.text]));
        renderBilingual(
          paragraphs.map((p) => ({
            id: p.id,
            text: byId.get(p.id) ?? p.text,
            original: p.node,
            inline: p.inline,
            hideOriginal: !settings.bilingual,
            style: settings.style,
          })),
        );
        for (const p of paragraphs) processedNodes.add(p.node);
        translated = true;
        setFabActive(true);
        startPageObserver();
        patchHistory();
      } catch (err) {
        showToast(`Lumen: ${(err as Error).message}`);
      } finally {
        busy = false;
        // If a route change was deferred while we were busy, re-run it now.
        // Only re-runs once per deferred route change (routePending is a single
        // boolean, not a counter), so this cannot loop unbounded.
        maybeFlushRoutePending();
      }
    }

    function togglePage() {
      if (translated) {
        stopPageObserver();
        unpatchHistory();
        clearBilingual();
        translated = false;
        processedNodes.clear();
        setFabActive(false);
      } else {
        void translatePage();
      }
    }

    // ---------- selection translation ----------
    let selPopup: HTMLDivElement | null = null;
    async function translateSelection() {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!text) return;
      const rect = sel!.getRangeAt(0).getBoundingClientRect();
      closeSelectionPopup();
      const popup = document.createElement("div");
      popup.className = "lumen-sel-popup";
      popup.style.left = `${Math.max(8, rect.left + window.scrollX)}px`;
      popup.style.top = `${rect.bottom + window.scrollY + 8}px`;
      popup.innerHTML = `
        <div class="lumen-sel-popup__head">
          <span>Lumen · ${escapeHtml(settings.activeEngineId)}</span>
          <button class="lumen-sel-popup__close" aria-label="close">×</button>
        </div>
        <div class="lumen-sel-popup__body">translating…</div>
        <button class="lumen-sel-popup__copy">copy</button>`;
      document.body.appendChild(popup);
      selPopup = popup;
      popup.querySelector(".lumen-sel-popup__close")?.addEventListener("click", closeSelectionPopup);
      popup.querySelector(".lumen-sel-popup__copy")?.addEventListener("click", () => {
        const body = popup.querySelector(".lumen-sel-popup__body")?.textContent ?? "";
        void navigator.clipboard.writeText(body);
      });
      try {
        const seg: Segment = { id: "sel", text };
        if (engine.supportsStreaming && engine.translateStream) {
          for await (const part of engine.translateStream({
            pair: { source: settings.sourceLang, target: settings.targetLang },
            segments: [seg],
            glossary: settings.glossary,
          })) {
            const body = popup.querySelector(".lumen-sel-popup__body");
            if (body) body.textContent = part.text || "…";
          }
        } else {
          const out = await translateSegments([seg]);
          const body = popup.querySelector(".lumen-sel-popup__body");
          if (body) body.textContent = out[0]?.text ?? text;
        }
      } catch (err) {
        const body = popup.querySelector(".lumen-sel-popup__body");
        if (body) body.textContent = `Error: ${(err as Error).message}`;
      }
    }

    function closeSelectionPopup() {
      selPopup?.remove();
      selPopup = null;
    }

    // ---------- hover translation ----------
    let hoverTimer: number | null = null;
    function onHover(e: MouseEvent) {
      if (!e.altKey) return;
      const target = (e.target as Element | null)?.closest(
        "p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, figcaption, summary, article, section, div",
      ) as Element | null;
      if (!target || target.tagName === "LUMEN-TRANSLATION") return;
      if (hoverTimer) window.clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(() => translateHovered(target), 120);
    }

    async function translateHovered(el: Element) {
      if (el.querySelector("lumen-translation")) return;
      const paragraphs = detectParagraphs({ root: el, minTextLength: 2 });
      if (paragraphs.length === 0) return;
      const segments = paragraphsToSegments(paragraphs);
      try {
        const out = await translateSegments(segments);
        const byId = new Map(out.map((s) => [s.id, s.text]));
        renderBilingual(
          paragraphs.map((p) => ({
            id: p.id,
            text: byId.get(p.id) ?? p.text,
            original: p.node,
            inline: p.inline,
            hideOriginal: false,
            style: settings.style,
          })),
        );
      } catch (err) {
        showToast(`Lumen: ${(err as Error).message}`);
      }
    }

    // ---------- input box translation ----------
    async function translateInput() {
      const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el) return;
      const tag = el.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA") return;
      const value = (el as HTMLInputElement).value;
      if (!value.trim()) return;
      try {
        const out = await translateSegments([{ id: "input", text: value }]);
        const translated = out[0]?.text ?? value;
        (el as HTMLInputElement).value = translated;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (err) {
        showToast(`Lumen: ${(err as Error).message}`);
      }
    }

    // ---------- floating ball ----------
    let fab: HTMLButtonElement | null = null;
    function ensureFab() {
      if (fab && fab.isConnected) return;
      const btn = document.createElement("button");
      btn.className = "lumen-fab";
      btn.textContent = "L";
      btn.title = "Lumen Translation (Alt+Q)";
      btn.addEventListener("click", togglePage);
      document.documentElement.appendChild(btn);
      fab = btn;
    }
    function setFabActive(active: boolean) {
      fab?.setAttribute("data-active", String(active));
    }
    function removeFab() {
      fab?.remove();
      fab = null;
    }

    // ---------- toast ----------
    function showToast(msg: string) {
      const t = document.createElement("div");
      t.textContent = msg;
      t.style.cssText =
        "position:fixed;left:50%;top:16px;transform:translateX(-50%);background:#111;color:#fff;padding:8px 14px;border-radius:6px;z-index:2147483647;font:13px system-ui;";
      document.documentElement.appendChild(t);
      setTimeout(() => t.remove(), 2400);
    }

    // ---------- rule matching ----------
    function matchRuleForUrl(url: string, s: Settings) {
      for (const r of s.rules) {
        try {
          if (globToRegex(r.match).test(url)) return r;
        } catch {
          // ignore malformed rule
        }
      }
      return undefined;
    }
    function globToRegex(glob: string): RegExp {
      const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(re);
    }

    // ---------- wire up ----------
    ensureFab();
    document.addEventListener("mousemove", onHover, { passive: true });
    document.addEventListener("scroll", closeSelectionPopup, { passive: true });

    const onMessage = (msg: { type?: string; command?: string; settings?: Settings }) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "command") {
        switch (msg.command) {
          case "toggle-translate":
            togglePage();
            break;
          case "translate-selection":
            void translateSelection();
            break;
          case "translate-input":
            void translateInput();
            break;
          case "open-popup":
            // handled by browser popup; no-op here
            break;
        }
        return;
      }
      switch (msg.type) {
        case "toggle-translate":
          togglePage();
          break;
        case "translate-selection":
          void translateSelection();
          break;
        case "translate-input":
          void translateInput();
          break;
        case "settings-broadcast":
          void refreshSettings(msg.settings);
          break;
      }
    };
    (browser.runtime?.onMessage as { addListener?: (cb: (msg: unknown) => void) => void } | undefined)
      ?.addListener?.((onMessage as (msg: unknown) => void));
    // Keep a handle so we could remove it on unload.
    (ctx as { addEventListener?: (ev: string, cb: () => void) => void })
      ?.addEventListener?.("invalid", () => {
        document.removeEventListener("mousemove", onHover);
        document.removeEventListener("scroll", closeSelectionPopup);
        stopPageObserver();
        unpatchHistory();
        clearBilingual();
        removeFab();
      });

    // Surface an external event API so other tools can drive Lumen
    // programmatically. Gated behind an opt-in setting because allowing any
    // page to trigger translation without user consent is a security risk.
    // `allowExternalControl` is not yet declared on the Settings type in
    // @lumen/core (we cannot edit core from here), so read it defensively and
    // default to false. The setting should be surfaced in the options UI later.
    const allowExternalControl =
      (settings as { allowExternalControl?: boolean }).allowExternalControl === true;
    if (allowExternalControl) {
      window.addEventListener("lumen", ((e: CustomEvent) => {
        const action = e.detail?.action;
        if (action === "toggle_translate") togglePage();
        else if (action === "translate_selection") void translateSelection();
        else if (action === "translate_input") void translateInput();
      }) as EventListener);
    }
  },
});

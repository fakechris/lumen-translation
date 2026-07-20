import { escapeHtml, type Engine, type LanguagePair } from "@lumen/core";

/** A single live caption line captured from a meeting. */
export interface Caption {
  /** Monotonic id (incremented per capture). */
  id: number;
  /** The captured text. */
  text: string;
  /** Approximate timestamp (ms since epoch). */
  ts: number;
  /** Speaker label if available. */
  speaker?: string;
}

export interface CaptionAdapter {
  /** Stable adapter id, e.g. "google-meet". */
  readonly id: string;
  /** True if this adapter recognises the current page. */
  detect(url: string): boolean;
  /** Start watching the meeting UI; emit captions via the callback. */
  start(onCaption: (c: Caption) => void): void;
  /** Stop watching and clean up any observers/timers. */
  stop(): void;
}

/** Translate captions as they arrive, emitting translated lines. */
export interface CaptionTranslator {
  /** Feed a raw caption; returns the translated text (eventually). */
  translate(caption: Caption): Promise<string>;
  /** Dispose any internal buffers. */
  dispose(): void;
}

/**
 * Create a caption translator backed by an Engine. Captions are debounced so
 * rapid partial updates from the same speaker are merged before translation.
 */
export function createCaptionTranslator(
  engine: Engine,
  pair: LanguagePair,
  opts: { debounceMs?: number } = {},
): CaptionTranslator {
  const debounceMs = opts.debounceMs ?? 350;
  let buffer = "";
  let lastSpeaker: string | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // All callers waiting on the current debounce window share one result.
  // A single `pending` resolver would leak earlier callers' Promises.
  let pending: Array<(text: string) => void> = [];

  const flush = async () => {
    const text = buffer.trim();
    buffer = "";
    timer = null;
    const waiters = pending;
    pending = [];
    if (!text || waiters.length === 0) {
      // Resolve waiters with empty input so they don't hang.
      for (const resolve of waiters) resolve(text);
      return;
    }
    try {
      const result = await engine.translate({
        pair,
        segments: [{ id: "c", text }],
      });
      const out = result.segments[0]?.text ?? text;
      for (const resolve of waiters) resolve(out);
    } catch (err) {
      const msg = `[lumen] ${(err as Error).message}`;
      for (const resolve of waiters) resolve(msg);
    }
  };

  return {
    async translate(caption: Caption): Promise<string> {
      // If speaker changed, flush the pending buffer first.
      if (lastSpeaker !== undefined && caption.speaker !== lastSpeaker && buffer) {
        if (timer) clearTimeout(timer);
        await flush();
      }
      lastSpeaker = caption.speaker;
      buffer = buffer ? `${buffer} ${caption.text}` : caption.text;
      return new Promise<string>((resolve) => {
        pending.push(resolve);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void flush(), debounceMs);
      });
    },
    dispose() {
      if (timer) clearTimeout(timer);
      buffer = "";
      pending = [];
      timer = null;
    },
  };
}

/**
 * Render translated captions into a floating overlay element. The host content
 * script creates the overlay and appends it to the page; this helper keeps it
 * scrolled to the latest line.
 */
export function createCaptionOverlay(doc: Document = document): {
  el: HTMLElement;
  push: (original: string, translated: string, speaker?: string) => void;
  clear: () => void;
} {
  const el = doc.createElement("div");
  el.className = "lumen-caption-overlay";
  el.style.cssText =
    "position:fixed;left:50%;bottom:80px;transform:translateX(-50%);" +
    "max-width:80vw;max-height:30vh;overflow:auto;z-index:2147483647;" +
    "background:rgba(17,17,17,.85);color:#fff;padding:10px 14px;border-radius:10px;" +
    "font:14px/1.6 system-ui,-apple-system,sans-serif;text-align:center;" +
    "backdrop-filter:blur(6px);box-shadow:0 8px 24px rgba(0,0,0,.35);";
  doc.documentElement.appendChild(el);
  return {
    el,
    push(original, translated, speaker) {
      const line = doc.createElement("div");
      line.style.marginBottom = "6px";
      const sp = speaker ? `<span style="opacity:.6;font-size:11px">${escapeHtml(speaker)}: </span>` : "";
      line.innerHTML =
        `${sp}<div style="opacity:.7">${escapeHtml(original)}</div>` +
        `<div style="color:#93c5fd">${escapeHtml(translated)}</div>`;
      el.appendChild(line);
      el.scrollTop = el.scrollHeight;
      // keep only the last 30 lines
      while (el.childElementCount > 30) el.removeChild(el.firstChild!);
    },
    clear() {
      el.textContent = "";
    },
  };
}

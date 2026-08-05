/**
 * The translation window — the Windows counterpart of `TranslateWindow` /
 * `TranslateContentView` in `LumenTranslationApp.swift`.
 *
 * Behaviour kept in parity with macOS: borderless floating card, fixed 400 px
 * width, height grows with content until the panes start scrolling, source
 * scroll drives the translation pane one-way, Esc / Ctrl+W and click-outside
 * hide (never destroy) the window so ⌥⌘L's counterpart can re-open it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CloseIcon, CopyIcon, SpeakIcon } from "./Icons";
import {
  allProviders,
  DEFAULT_SETTINGS,
  loadSettings,
  onSettingsChanged,
  type Settings,
} from "./settings";
import { translate, TranslationFailed } from "./translate";

const WIDTH = 400;
/** 28 top + 12 + divider + 12 + 14 + 24 footer + 14 bottom. */
const CHROME_HEIGHT = 105;
const MIN_HEIGHT = 240;

interface Payload {
  source: string;
  translation: string;
  engine: string;
  /** Set when the translation failed outright, so the pane can style it red. */
  failed?: boolean;
}

const EMPTY: Payload = { source: "", translation: "", engine: "" };

export function TranslateWindow() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [payload, setPayload] = useState<Payload>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const sourceRef = useRef<HTMLDivElement>(null);
  const translationRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // Guards the one-way scroll sync against feedback.
  const syncing = useRef(false);
  // Lets a newly arrived request cancel the one in flight.
  const runId = useRef(0);
  // Last height asked of Rust, so an echoed resize isn't re-sent.
  const lastHeight = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    loadSettings().then(setSettings).catch(console.error);
    const un = onSettingsChanged(setSettings);
    return () => {
      un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  // The tray's Engine submenu is rendered by Rust but populated from here: the
  // provider catalog is parsed once, in TypeScript, and this window is the one
  // that is always alive to push it.
  useEffect(() => {
    const engines = allProviders(settings).map((p) => ({
      id: p.id,
      label: p.label,
    }));
    void invoke("set_engine_list", { engines }).catch(console.error);
  }, [settings]);

  const run = useCallback(async (text: string) => {
    const id = ++runId.current;
    setBusy(true);
    setCopied(false);
    setPayload({ source: text, translation: "", engine: "" });
    try {
      const res = await translate(text, settingsRef.current, {
        onPartial: (partial, engine) => {
          if (runId.current !== id) return;
          setPayload({ source: text, translation: partial, engine });
        },
      });
      if (runId.current !== id) return;
      setPayload({ source: text, translation: res.translation, engine: res.engine });
    } catch (err) {
      if (runId.current !== id) return;
      const message =
        err instanceof TranslationFailed ? err.message : String(err);
      setPayload({
        source: text,
        translation: `Lumen error: ${message}`,
        engine: "error",
        failed: true,
      });
    } finally {
      if (runId.current === id) setBusy(false);
    }
  }, []);

  // Requests arrive from the tray, the global hotkey, or the action bar.
  useEffect(() => {
    const un = listen<{ text: string }>("translate-text", (e) => {
      const text = e.payload.text.trim();
      if (text) void run(text);
    });
    return () => {
      un.then((f) => f()).catch(() => undefined);
    };
  }, [run]);

  const hide = useCallback(() => {
    void getCurrentWindow().hide();
  }, []);

  // Esc and Ctrl+W hide the window. There is no menu bar on a borderless
  // window, so the accelerator is handled here rather than by the OS.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || (e.ctrlKey && e.key.toLowerCase() === "w")) {
        e.preventDefault();
        hide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hide]);

  // Click-outside hides, matching `windowDidResignKey` on macOS.
  useEffect(() => {
    const un = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!focused) hide();
    });
    return () => {
      un.then((f) => f()).catch(() => undefined);
    };
  }, [hide]);

  // Resize to fit: the panes are capped at a fraction of the work area so long
  // text scrolls inside them instead of producing an unusably tall window.
  // Rust owns the actual placement because it can read the monitor work area.
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const measure = () => {
      const height = Math.max(
        MIN_HEIGHT,
        Math.ceil(
          CHROME_HEIGHT +
            (sourceRef.current?.scrollHeight ?? 0) +
            (translationRef.current?.scrollHeight ?? 0),
        ),
      );
      // Resizing the window changes the panes' box size, which fires the
      // observer again. The measurement is content-based so it converges, but
      // skipping the no-op keeps it to one round trip instead of two — and
      // stops a rounding disagreement between here and Rust from ping-ponging.
      if (height === lastHeight.current) return;
      lastHeight.current = height;
      void invoke("place_translate_window", { width: WIDTH, height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (sourceRef.current) ro.observe(sourceRef.current);
    if (translationRef.current) ro.observe(translationRef.current);
    return () => ro.disconnect();
  }, [payload.source, payload.translation]);

  // Scrolling the source drives the translation proportionally; scrolling the
  // translation does not move the source (one-way, as on macOS).
  const onSourceScroll = () => {
    if (syncing.current) return;
    const src = sourceRef.current;
    const dst = translationRef.current;
    if (!src || !dst) return;
    const sMax = src.scrollHeight - src.clientHeight;
    const dMax = dst.scrollHeight - dst.clientHeight;
    if (sMax <= 1 || dMax <= 1) return;
    syncing.current = true;
    dst.scrollTop = (src.scrollTop / sMax) * dMax;
    syncing.current = false;
  };

  const onCopy = async () => {
    await navigator.clipboard.writeText(payload.translation);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const onSpeak = () => {
    const u = new SpeechSynthesisUtterance(payload.translation);
    u.lang = settings.targetLang;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  };

  const hasTranslation = payload.translation.length > 0 && !payload.failed;

  return (
    <div className="card translate-card" ref={cardRef} style={{ position: "relative" }}>
      <button className="close-button" onClick={hide} title="Close (Esc)">
        <CloseIcon />
      </button>

      <div
        className="text-pane source"
        ref={sourceRef}
        onScroll={onSourceScroll}
        style={{ maxHeight: "35vh" }}
      >
        {payload.source}
      </div>

      <div className="divider" />

      <div
        className={`text-pane translation${payload.failed ? " error" : ""}`}
        ref={translationRef}
        style={{ maxHeight: "45vh" }}
      >
        {payload.translation}
      </div>

      <div className="footer">
        <button
          className="icon-button"
          onClick={onCopy}
          disabled={!hasTranslation}
          title="Copy translation"
        >
          <CopyIcon />
          Copy
        </button>
        <button
          className="icon-button"
          onClick={onSpeak}
          disabled={!hasTranslation}
          title="Speak translation"
        >
          <SpeakIcon />
          Speak
        </button>
        {busy && <div className="spinner" />}
        <span className={`engine-label${copied ? " status" : ""}`}>
          {copied ? "Copied" : payload.engine}
        </span>
      </div>
    </div>
  );
}

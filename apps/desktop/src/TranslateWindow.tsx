/**
 * The translation window — the Windows counterpart of `TranslateWindow` /
 * `TranslateContentView` in `LumenTranslationApp.swift`.
 *
 * Behaviour kept in parity with macOS: borderless floating card, fixed 400 px
 * width, height grows with content until the panes start scrolling, source
 * scroll drives the translation pane one-way, Esc / Ctrl+W and click-outside
 * hide (never destroy) the window so ⌥⌘L's counterpart can re-open it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CloseIcon, CopyIcon, SpeakIcon } from './Icons';
import {
  allProviders,
  DEFAULT_SETTINGS,
  loadSettings,
  onSettingsChanged,
  type Settings,
} from './settings';
import { translate, TranslationFailed } from './translate';
import {
  CARD_WIDTH,
  SOURCE_AREA_SHARE,
  TRANSLATION_AREA_SHARE,
  paneCap,
  translateWindowHeight,
} from './translate-window-sizing';

/** Geometry the card needs from the display it appears on. */
interface WindowMetrics {
  /** Usable height of that display, in CSS pixels. */
  workAreaHeight: number;
}

/**
 * How long the card's size waits for the content to settle before it is
 * applied. A streaming translation arrives in chunks; without this the card
 * would be resized once per chunk.
 */
const SIZE_COALESCE_MS = 120;

interface Payload {
  source: string;
  translation: string;
  engine: string;
  /** Set when the translation failed outright, so the pane can style it red. */
  failed?: boolean;
}

const EMPTY: Payload = { source: '', translation: '', engine: '' };

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
  const settingsReady = useRef<Promise<Settings> | null>(null);
  // The card is capped to a share of the display's work area, so its height
  // depends on the display rather than on the card. Loaded once.
  const [metrics, setMetrics] = useState<WindowMetrics | null>(null);
  const metricsReady = useRef<Promise<WindowMetrics> | null>(null);

  const applyLoadedSettings = useCallback((next: Settings) => {
    settingsRef.current = next;
    setSettings(next);
  }, []);

  const ensureSettings = useCallback(() => {
    if (!settingsReady.current) {
      settingsReady.current = loadSettings().then((next) => {
        applyLoadedSettings(next);
        return next;
      });
    }
    return settingsReady.current;
  }, [applyLoadedSettings]);

  const ensureMetrics = useCallback(() => {
    if (!metricsReady.current) {
      metricsReady.current = invoke<WindowMetrics>('translate_window_metrics').then((next) => {
        setMetrics(next);
        return next;
      });
    }
    return metricsReady.current;
  }, []);

  useEffect(() => {
    void ensureSettings().catch(console.error);
    const un = onSettingsChanged((next) => {
      applyLoadedSettings(next);
      settingsReady.current = Promise.resolve(next);
    });
    return () => {
      un.then((f) => f()).catch(() => undefined);
    };
  }, [applyLoadedSettings, ensureSettings]);

  // The tray's Engine submenu is rendered by Rust but populated from here: the
  // provider catalog is parsed once, in TypeScript, and this window is the one
  // that is always alive to push it.
  useEffect(() => {
    const engines = allProviders(settings).map((p) => ({
      id: p.id,
      label: p.label,
    }));
    void invoke('set_engine_list', { engines }).catch(console.error);
  }, [settings]);

  const run = useCallback(
    async (text: string) => {
      const loaded = await ensureSettings();
      const activeSettings = settingsRef.current ?? loaded;
      const id = ++runId.current;
      setBusy(true);
      setCopied(false);
      setPayload({ source: text, translation: '', engine: '' });
      try {
        const res = await translate(text, activeSettings, {
          onPartial: (partial, engine) => {
            if (runId.current !== id) return;
            setPayload({ source: text, translation: partial, engine });
          },
        });
        if (runId.current !== id) return;
        setPayload({ source: text, translation: res.translation, engine: res.engine });
      } catch (err) {
        if (runId.current !== id) return;
        const message = err instanceof TranslationFailed ? err.message : String(err);
        setPayload({
          source: text,
          translation: `Lumen error: ${message}`,
          engine: 'error',
          failed: true,
        });
      } finally {
        if (runId.current === id) setBusy(false);
      }
    },
    [ensureSettings],
  );

  // Requests arrive from the tray, the global hotkey, or the action bar. The
  // event is only a wake-up: the payload is pulled from Rust after this
  // listener exists, so the first request cannot disappear during React mount.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const consumePending = async () => {
      const pending = await invoke<string | null>('take_pending_translation');
      const text = pending?.trim();
      if (!disposed && text) await run(text);
    };
    void listen('translate-text', () => void consumePending())
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
        return consumePending();
      })
      .catch(console.error);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [run]);

  const hide = useCallback(() => {
    void getCurrentWindow().hide();
  }, []);

  // Esc and Ctrl+W hide the window. There is no menu bar on a borderless
  // window, so the accelerator is handled here rather than by the OS.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e.ctrlKey && e.key.toLowerCase() === 'w')) {
        e.preventDefault();
        hide();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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

  // Resize to fit: the panes are capped to a share of the display's work
  // area, so long text scrolls inside them instead of producing an unusably
  // tall window. Rust owns the actual placement because it can read the
  // monitor work area.
  //
  // The panes are measured by their *content* height (`scrollHeight`), not by
  // the capped height (`clientHeight`): the cap is a constant of the display,
  // so the target height never depends on the card's current height. The old
  // `vh` + `clientHeight` pairing made the target a function of the current
  // height, and the card walked to its fixed point one native resize at a
  // time — about twenty resizes per translation.
  const applySize = useCallback(() => {
    if (!metrics) return;
    const height = translateWindowHeight({
      sourceContentHeight: sourceRef.current?.scrollHeight ?? 0,
      translationContentHeight: translationRef.current?.scrollHeight ?? 0,
      workAreaHeight: metrics.workAreaHeight,
    });
    if (height === lastHeight.current) return;
    lastHeight.current = height;
    void invoke('place_translate_window', { width: CARD_WIDTH, height });
  }, [metrics]);

  // Resizing the native window costs a full webview re-layout and repaint, so
  // the size is applied on the leading edge — the source text lands at once —
  // and then coalesced. A streaming translation delivers a chunk every few tens
  // of milliseconds, and resizing for each of them walks the window up in
  // twenty steps while the text is still arriving.
  const sizeTimer = useRef<number | null>(null);
  const scheduleSize = useCallback(() => {
    if (sizeTimer.current === null) {
      applySize();
      sizeTimer.current = window.setTimeout(() => {
        sizeTimer.current = null;
      }, SIZE_COALESCE_MS);
      return;
    }
    window.clearTimeout(sizeTimer.current);
    sizeTimer.current = window.setTimeout(() => {
      sizeTimer.current = null;
      applySize();
    }, SIZE_COALESCE_MS);
  }, [applySize]);

  useEffect(
    () => () => {
      if (sizeTimer.current !== null) window.clearTimeout(sizeTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!metrics) {
      void ensureMetrics().catch(console.error);
      return;
    }
    scheduleSize();
    // Late layout changes (a web font landing, for instance) can still alter
    // the content height. Re-measuring is free: the height is only sent to
    // Rust when it actually changed.
    const ro = new ResizeObserver(() => scheduleSize());
    if (sourceRef.current) ro.observe(sourceRef.current);
    if (translationRef.current) ro.observe(translationRef.current);
    return () => ro.disconnect();
  }, [payload.source, payload.translation, metrics, ensureMetrics, scheduleSize]);

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
    <div className="card translate-card" ref={cardRef} style={{ position: 'relative' }}>
      <button className="close-button" onClick={hide} title="Close (Esc)">
        <CloseIcon />
      </button>

      <div
        className="text-pane source"
        ref={sourceRef}
        onScroll={onSourceScroll}
        style={
          metrics ? { maxHeight: paneCap(metrics.workAreaHeight, SOURCE_AREA_SHARE) } : undefined
        }
      >
        {payload.source}
      </div>

      <div className="divider" />

      <div
        className={`text-pane translation${payload.failed ? ' error' : ''}`}
        ref={translationRef}
        style={
          metrics
            ? { maxHeight: paneCap(metrics.workAreaHeight, TRANSLATION_AREA_SHARE) }
            : undefined
        }
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
        <span className={`engine-label${copied ? ' status' : ''}`}>
          {copied ? 'Copied' : payload.engine}
        </span>
      </div>
    </div>
  );
}

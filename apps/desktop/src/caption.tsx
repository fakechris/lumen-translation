// Live subtitle overlay. Its presentation model uses a continuous bilingual flow:
// scrollback history → current committed bilingual caption → mutable draft.
// The streaming pass owns immediacy; Whisper can revise an utterance later,
// and the revised translation is backfilled without moving that utterance.
import './styles.css';
import { StrictMode, useEffect, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  captionReducer,
  initialCaptionState,
  shouldAcceptCaptionSession,
  type CaptionEvent,
  type CaptionLine,
  type CaptionRefineEvent,
  type CaptionWindowStatus,
} from './caption-state';
import { captionFixtureState } from './caption-fixtures';
import { TARGET_LANGS } from './lang';
import {
  allProviders,
  apiKeyFor,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
} from './settings';
import {
  translate,
  TranslationFailed,
  TranslationFlightController,
  type TranslateContext,
} from './translate';

const VISIBLE_CAPTIONS = 8;
const FINAL_TRANSLATION_SETTLE_MS = 180;
const DRAFT_TRANSLATION_SETTLE_MS = 320;
const PREVIEW_STATE = captionFixtureState(
  new URLSearchParams(window.location.search).get('fixture'),
);

const TARGET_LANG_MAP: Record<string, string> = {
  'zh-CN': '中文',
  'zh-TW': '繁体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  ru: 'Русский',
  it: 'Italiano',
  pt: 'Português',
  vi: 'Tiếng Việt',
  th: 'ไทย',
  ar: 'العربية',
  id: 'Bahasa Indonesia',
};

interface ScheduledTranslation {
  signature: string;
  timer: number;
}

type CaptionOutputEntry =
  | {
      sessionId: number;
      eventId: number;
      kind: 'partial' | 'final';
      payload: CaptionEvent;
    }
  | {
      sessionId: number;
      eventId: number;
      kind: 'refine';
      payload: CaptionRefineEvent;
    };

interface CaptionEventSnapshot {
  sessionId: number;
  entries: CaptionOutputEntry[];
}

interface CaptionSessionResetEvent {
  sessionId: number;
  appName: string;
}

function GlobeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function SubtitlesIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="4" width="20" height="16" rx="3" />
      <path d="M7 15h3M14 15h3M7 11h10" />
    </svg>
  );
}

function FontSizeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 19L8.5 7h1L14 19" />
      <path d="M6 15h6.5" />
      <path d="M16 19l2.5-6h.8l2.7 6" />
      <path d="M17.5 16h3.5" />
    </svg>
  );
}

function ExpandIcon({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  ) : (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function liveCaptionSettings(settings: Settings): Settings {
  // Live subtitles cannot afford the retry/backoff chain of a rate-limited
  // free endpoint. When the user has configured an LLM, use the first keyed
  // provider directly for this latency-sensitive surface. Normal selection
  // translation keeps the user's ordinary provider order unchanged.
  const configured = allProviders(settings).find(
    (provider) => provider.apiStyle === 'openai_compat' && apiKeyFor(settings, provider.id),
  );
  return configured ? { ...settings, providerId: configured.id } : settings;
}

function getContextForUtterance(
  captions: CaptionLine[],
  currentId?: string,
): TranslateContext | undefined {
  const previousLines = captions.filter(
    (c) => c.id !== currentId && c.sourceText && c.translation,
  );
  if (previousLines.length === 0) return undefined;
  const recent = previousLines.slice(-2);
  const previousSource = recent.map((c) => c.sourceText).join(' ');
  const previousTranslation = recent.map((c) => c.translation).join(' ');
  return { previousSource, previousTranslation };
}

function CaptionPair({
  line,
  history,
  showOriginal,
}: {
  line: CaptionLine;
  history: boolean;
  showOriginal: boolean;
}) {
  const hasTranslation = Boolean(line.translation?.trim());
  return (
    <div
      className={`caption-block ${history ? 'history' : 'committed'}`}
      data-corrected={line.corrected || undefined}
    >
      {showOriginal && (
        <div className="caption-line original">
          {line.sourceText}
        </div>
      )}
      <div className="caption-line translation">
        {hasTranslation ? (
          line.translation
        ) : showOriginal ? (
          <span className="caption-translating-pulse">…</span>
        ) : (
          line.sourceText
        )}
      </div>
    </div>
  );
}

function CaptionOverlay() {
  const [state, dispatch] = useReducer(captionReducer, PREVIEW_STATE ?? initialCaptionState);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showOriginal, setShowOriginal] = useState<boolean>(() => {
    try {
      return localStorage.getItem('lumen_caption_show_original') !== 'false';
    } catch {
      return true;
    }
  });
  const [fontSize, setFontSize] = useState<'small' | 'medium' | 'large'>(() => {
    try {
      return (localStorage.getItem('lumen_caption_font_size') as 'small' | 'medium' | 'large') || 'medium';
    } catch {
      return 'medium';
    }
  });
  const [expanded, setExpanded] = useState(false);

  const flowRef = useRef<HTMLDivElement>(null);
  const statusRevision = useRef(0);
  const captionSessionActive = useRef(false);
  const captionSessionId = useRef<number | null>(null);
  const lastCaptionEventId = useRef(0);
  const captionTranslationTimers = useRef<Map<string, ScheduledTranslation>>(new Map());
  const flightController = useRef(new TranslationFlightController());

  // Auto-scroll to the newest caption
  useEffect(() => {
    if (flowRef.current) {
      flowRef.current.scrollTo({
        top: flowRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [state.captions, state.draft]);

  // Escape key closes live subtitles
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        invoke('live_subtitle_stop').catch(console.error);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleClose = () => {
    invoke('live_subtitle_stop').catch(console.error);
  };

  const handleOpenSettings = () => {
    invoke('open_preferences').catch(console.error);
  };

  const handleToggleOriginal = () => {
    const next = !showOriginal;
    setShowOriginal(next);
    try {
      localStorage.setItem('lumen_caption_show_original', String(next));
    } catch {}
  };

  const handleFontSizeChange = (next: 'small' | 'medium' | 'large') => {
    setFontSize(next);
    try {
      localStorage.setItem('lumen_caption_font_size', next);
    } catch {}
  };

  const handleToggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    invoke('set_caption_expanded', { expanded: next }).catch(console.error);
  };

  const handleTargetLangChange = (newLang: string) => {
    if (!settings) return;
    const nextSettings: Settings = { ...settings, targetLang: newLang };
    setSettings(nextSettings);
    saveSettings(nextSettings).catch(console.error);
  };

  useEffect(() => {
    if (PREVIEW_STATE) return;
    loadSettings()
      .then(setSettings)
      .catch((error) => {
        // Captions remain useful without provider settings. Do not turn a
        // translation-only failure into a full-screen capture error.
        console.warn('[caption] settings unavailable; showing source captions only', error);
      });

    const unlisten = listen<Settings>('settings-changed', (event) => {
      setSettings((prev) => ({ ...(prev ?? DEFAULT_SETTINGS), ...event.payload }));
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (PREVIEW_STATE) return;
    let disposed = false;
    let pullInFlight = false;

    const applyStatus = (status: CaptionWindowStatus) => {
      dispatch({ type: 'status', status });
    };

    const applyCaptionEntry = (entry: CaptionOutputEntry) => {
      if (
        !shouldAcceptCaptionSession(
          captionSessionActive.current,
          captionSessionId.current,
          entry.sessionId,
        )
      )
        return;
      if (captionSessionId.current !== entry.sessionId) {
        captionSessionId.current = entry.sessionId;
        lastCaptionEventId.current = 0;
        dispatch({ type: 'reset' });
      }
      if (entry.eventId <= lastCaptionEventId.current) return;
      lastCaptionEventId.current = entry.eventId;
      if (entry.kind === 'partial') {
        dispatch({ type: 'partial', event: entry.payload });
      } else if (entry.kind === 'final') {
        dispatch({ type: 'final', event: entry.payload });
      } else {
        dispatch({ type: 'refine', event: entry.payload });
      }
    };

    const applyCaptionSnapshot = (snapshot: CaptionEventSnapshot) => {
      if (
        !shouldAcceptCaptionSession(
          captionSessionActive.current,
          captionSessionId.current,
          snapshot.sessionId,
        )
      )
        return;
      if (snapshot.sessionId !== captionSessionId.current) {
        captionSessionId.current = snapshot.sessionId;
        lastCaptionEventId.current = 0;
        dispatch({ type: 'reset' });
      }
      for (const entry of snapshot.entries) applyCaptionEntry(entry);
    };

    const pullCaptionEvents = () => {
      if (
        disposed ||
        pullInFlight ||
        !captionSessionActive.current ||
        document.visibilityState === 'hidden'
      )
        return Promise.resolve();
      pullInFlight = true;
      return invoke<CaptionEventSnapshot>('live_subtitle_events', {
        sessionId: captionSessionId.current,
        afterEventId: lastCaptionEventId.current,
      })
        .then((snapshot) => {
          if (!disposed) applyCaptionSnapshot(snapshot);
        })
        .finally(() => {
          pullInFlight = false;
        });
    };

    const unlisteners: Promise<() => void>[] = [
      listen<CaptionOutputEntry>('caption-output', (event) => {
        applyCaptionEntry(event.payload);
      }),
      listen<string>('caption-error', (event) => {
        statusRevision.current += 1;
        captionSessionActive.current = false;
        applyStatus({ kind: 'error', message: event.payload });
      }),
      listen<string>('caption-target', (event) => {
        statusRevision.current += 1;
        applyStatus({ kind: 'target', message: event.payload });
      }),
      listen<CaptionSessionResetEvent>('caption-session-reset', (event) => {
        statusRevision.current += 1;
        captionSessionActive.current = true;
        captionSessionId.current = event.payload.sessionId;
        lastCaptionEventId.current = 0;
        dispatch({ type: 'reset' });
        applyStatus({ kind: 'target', message: event.payload.appName });
        void pullCaptionEvents().catch((error) =>
          console.warn('[caption] session-start recovery sync failed', error),
        );
      }),
      listen('caption-stopped', () => {
        captionSessionActive.current = false;
        captionSessionId.current = null;
        lastCaptionEventId.current = 0;
        dispatch({ type: 'reset' });
      }),
    ];

    const pullStatus = () => {
      const revisionBeforePull = statusRevision.current;
      return invoke<CaptionWindowStatus | null>('live_subtitle_status').then((status) => {
        if (!disposed && status && revisionBeforePull === statusRevision.current) {
          applyStatus(status);
        }
      });
    };

    // The window is now pre-created at app launch, but keep the pull as a
    // recovery path for a WebView reload or a capability/plugin restart.
    void pullStatus().catch((error) => console.warn('[caption] initial status sync failed', error));
    void Promise.all(unlisteners)
      .then(async () => {
        const running = await invoke<boolean>('live_subtitle_running');
        if (disposed) return;
        captionSessionActive.current = running;
        await Promise.all([pullStatus(), pullCaptionEvents()]);
      })
      .catch((error) => console.warn('[caption] listener/status sync failed', error));
    const recoveryTimer = window.setInterval(() => {
      void pullCaptionEvents().catch((error) =>
        console.warn('[caption] event recovery sync failed', error),
      );
    }, 750);
    const recoverWhenVisible = () => {
      if (document.visibilityState !== 'hidden' && captionSessionActive.current) {
        void pullCaptionEvents().catch((error) =>
          console.warn('[caption] visibility recovery sync failed', error),
        );
      }
    };
    document.addEventListener('visibilitychange', recoverWhenVisible);

    return () => {
      disposed = true;
      window.clearInterval(recoveryTimer);
      document.removeEventListener('visibilitychange', recoverWhenVisible);
      for (const pending of unlisteners) void pending.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (!settings || !state.draft?.sourceText.trim()) {
      flightController.current.cancelDraft();
      return;
    }

    const { utterance, sourceText } = state.draft;
    const context = getContextForUtterance(state.captions);
    const timer = window.setTimeout(() => {
      flightController.current
        .requestDraft(
          utterance,
          sourceText,
          liveCaptionSettings(settings),
          (result) => {
            dispatch({
              type: 'draft-translation',
              utterance,
              sourceText,
              translation: result.translation,
            });
          },
          context,
        )
        .catch((error) => {
          if (!(error instanceof TranslationFailed)) {
            console.warn('[caption] draft translation failed', error);
          }
        });
    }, DRAFT_TRANSLATION_SETTLE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [settings, state.draft?.sourceText, state.draft?.utterance, state.captions]);

  useEffect(() => {
    if (!settings) return;
    const timers = captionTranslationTimers.current;
    const activeIds = new Set(state.captions.map((caption) => caption.id));

    for (const [id, scheduled] of timers) {
      const caption = state.captions.find((candidate) => candidate.id === id);
      if (!activeIds.has(id) || caption?.translation) {
        window.clearTimeout(scheduled.timer);
        timers.delete(id);
        flightController.current.cancelFinal(id);
      }
    }

    for (const caption of state.captions) {
      if (caption.translation || !caption.sourceText.trim()) continue;
      const signature = `${caption.id}:${caption.sourceText}`;
      const existing = timers.get(caption.id);
      if (existing?.signature === signature) continue;
      if (existing) window.clearTimeout(existing.timer);

      const context = getContextForUtterance(state.captions, caption.id);
      const timer = window.setTimeout(
        () => {
          const scheduled = timers.get(caption.id);
          if (scheduled?.signature !== signature) return;
          timers.delete(caption.id);
          flightController.current
            .requestFinal(
              caption.id,
              caption.sourceText,
              liveCaptionSettings(settings),
              (result) => {
                dispatch({
                  type: 'caption-translation',
                  id: caption.id,
                  sourceText: caption.sourceText,
                  translation: result.translation,
                });
              },
              context,
            )
            .catch((error) => {
              if (!(error instanceof TranslationFailed)) {
                console.warn('[caption] final translation failed', error);
              }
            });
        },
        caption.corrected ? 0 : FINAL_TRANSLATION_SETTLE_MS,
      );

      timers.set(caption.id, { signature, timer });
    }
  }, [settings, state.captions]);

  useEffect(
    () => () => {
      for (const scheduled of captionTranslationTimers.current.values()) {
        window.clearTimeout(scheduled.timer);
      }
      captionTranslationTimers.current.clear();
      flightController.current.abortAll();
    },
    [],
  );

  const visibleCaptions = state.captions.slice(-VISIBLE_CAPTIONS);
  const hasContent = visibleCaptions.length > 0 || Boolean(state.draft);
  const isTranslationConfigured = Boolean(
    settings &&
    allProviders(settings).some(
      (provider) => provider.apiStyle === 'openai_compat' && apiKeyFor(settings, provider.id),
    ),
  );

  const currentTargetLangLabel =
    TARGET_LANG_MAP[settings?.targetLang ?? 'zh-CN'] ??
    TARGET_LANGS.find((l) => l.code === settings?.targetLang)?.label ??
    '中文';

  return (
    <div
      className={`caption-overlay${state.error ? ' has-error' : ''}${
        expanded ? ' is-expanded' : ''
      }`}
    >
      <div className={`caption-surface font-${fontSize}`}>
        {/* Doubao-style Floating Controls Header */}
        <div className="caption-header" data-tauri-drag-region>
          <div className="caption-header-left">
            {/* 1. Target Language Dropdown */}
            <div className="caption-select-wrapper" title="选择目标翻译语言">
              <GlobeIcon />
              <span className="caption-select-label">
                翻译为: {currentTargetLangLabel}
              </span>
              <ChevronDownIcon />
              <select
                className="caption-select-hidden"
                value={settings?.targetLang ?? 'zh-CN'}
                onChange={(e) => handleTargetLangChange(e.target.value)}
              >
                {TARGET_LANGS.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>

            {/* 2. Original Text Toggle Button */}
            <button
              type="button"
              className={`caption-pill-btn${showOriginal ? ' active' : ''}`}
              onClick={handleToggleOriginal}
              title={showOriginal ? '点击关闭原文（仅保留译文）' : '点击显示原文'}
            >
              <SubtitlesIcon />
              <span>{showOriginal ? '关闭原文' : '显示原文'}</span>
            </button>

            {/* 3. Font Size Dropdown */}
            <div className="caption-select-wrapper" title="切换字幕字体大小">
              <FontSizeIcon />
              <span className="caption-select-label">
                {fontSize === 'small' ? '小号字体' : fontSize === 'large' ? '大号字体' : '中号字体'}
              </span>
              <ChevronDownIcon />
              <select
                className="caption-select-hidden"
                value={fontSize}
                onChange={(e) =>
                  handleFontSizeChange(e.target.value as 'small' | 'medium' | 'large')
                }
              >
                <option value="small">小号字体</option>
                <option value="medium">中号字体</option>
                <option value="large">大号字体</option>
              </select>
            </div>

            {/* Listening target app badge */}
            {state.appName && (
              <div className="caption-target-badge" title={`正在监听: ${state.appName}`}>
                <span className={`caption-status-dot${hasContent ? '' : ' idle'}`} />
                <span>{state.appName}</span>
              </div>
            )}
          </div>

          <div className="caption-header-right">
            {/* 4. Expand / Collapse Subtitles */}
            <button
              type="button"
              className={`caption-pill-btn${expanded ? ' active' : ''}`}
              onClick={handleToggleExpand}
              title={expanded ? '收起历史字幕' : '展开历史字幕'}
            >
              <ExpandIcon expanded={expanded} />
              <span>{expanded ? '收起字幕' : '展开字幕'}</span>
            </button>

            {/* 5. Settings */}
            <button
              type="button"
              className="caption-icon-btn"
              onClick={handleOpenSettings}
              title="偏好设置 (配置翻译模型 API Key)"
            >
              <SettingsIcon />
            </button>

            {/* 6. Close */}
            <button
              type="button"
              className="caption-icon-btn close"
              onClick={handleClose}
              title="关闭实时字幕 (Esc)"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Translation warning pill if no LLM key is set */}
        {!isTranslationConfigured && !state.error && hasContent && (
          <button
            type="button"
            className="caption-warn-pill"
            onClick={handleOpenSettings}
            title="点击打开偏好设置配置 LLM API Key (如 DeepSeek / GLM)"
          >
            <span>💡 未配置翻译 Key，点击设置</span>
          </button>
        )}

        {state.error ? (
          <div className="caption-hint error">{state.error}</div>
        ) : (
          <>
            {!hasContent && (
              <div className="caption-hint">
                {state.appName ? `正在听 ${state.appName}…` : '正在启动字幕…'}
              </div>
            )}
            <div className="caption-flow" ref={flowRef}>
              <div className="caption-flow-spacer" />
              {visibleCaptions.map((line, index) => (
                <CaptionPair
                  key={line.id}
                  line={line}
                  history={index < visibleCaptions.length - 1}
                  showOriginal={showOriginal}
                />
              ))}
              {state.draft && (
                <div className="caption-block draft" key={`draft-${state.draft.utterance}`}>
                  {showOriginal && (
                    <div className="caption-line original draft-original">
                      <span className="draft-stable">
                        {state.draft.sourceText.slice(0, state.draft.stablePrefixLength)}
                      </span>
                      <span className="draft-mutable">
                        {state.draft.sourceText.slice(state.draft.stablePrefixLength)}
                      </span>
                    </div>
                  )}
                  <div
                    className={`caption-line translation draft-translation${
                      state.draft.translation ? '' : ' placeholder'
                    }`}
                    aria-hidden={!state.draft.translation}
                  >
                    {state.draft.translation ?? (showOriginal ? ' ' : state.draft.sourceText)}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CaptionOverlay />
  </StrictMode>,
);

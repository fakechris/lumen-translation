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
import { allProviders, apiKeyFor, DEFAULT_SETTINGS, loadSettings, type Settings } from './settings';
import { translate, TranslationFailed } from './translate';

const VISIBLE_CAPTIONS = 3;
const FINAL_TRANSLATION_SETTLE_MS = 180;
const DRAFT_TRANSLATION_SETTLE_MS = 320;
const PREVIEW_STATE = captionFixtureState(
  new URLSearchParams(window.location.search).get('fixture'),
);

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

function LockIcon({ locked }: { locked: boolean }) {
  return locked ? (
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
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
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
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
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

function CaptionPair({ line, history }: { line: CaptionLine; history: boolean }) {
  // Keep one stable slot while translation is pending: source text uses
  // the larger translated typography, then becomes the quieter second line
  // when the translation arrives. That avoids both an ellipsis and a jump.
  const hasTranslation = Boolean(line.translation?.trim());
  return (
    <div
      className={`caption-block ${history ? 'history' : 'committed'}`}
      data-corrected={line.corrected || undefined}
    >
      <div className="caption-line translation">
        {hasTranslation ? line.translation : line.sourceText}
      </div>
      {hasTranslation && <div className="caption-line original">{line.sourceText}</div>}
    </div>
  );
}

function CaptionOverlay() {
  const [state, dispatch] = useReducer(captionReducer, PREVIEW_STATE ?? initialCaptionState);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [clickthrough, setClickthrough] = useState(false);
  const statusRevision = useRef(0);
  const captionSessionActive = useRef(false);
  const captionSessionId = useRef<number | null>(null);
  const lastCaptionEventId = useRef(0);
  const captionTranslationTimers = useRef<Map<string, ScheduledTranslation>>(new Map());

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

  const handleToggleClickthrough = () => {
    const next = !clickthrough;
    setClickthrough(next);
    invoke('set_caption_clickthrough', { clickthrough: next }).catch(console.error);
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
    if (!settings || !state.draft?.sourceText.trim()) return;

    const { utterance, sourceText } = state.draft;
    const timer = window.setTimeout(() => {
      translate(sourceText, liveCaptionSettings(settings))
        .then((result) => {
          dispatch({
            type: 'draft-translation',
            utterance,
            sourceText,
            translation: result.translation,
          });
        })
        .catch((error) => {
          if (!(error instanceof TranslationFailed)) {
            console.warn('[caption] draft translation failed', error);
          }
        });
    }, DRAFT_TRANSLATION_SETTLE_MS);

    return () => window.clearTimeout(timer);
  }, [settings, state.draft?.sourceText, state.draft?.utterance]);

  useEffect(() => {
    if (!settings) return;
    const timers = captionTranslationTimers.current;
    const activeIds = new Set(state.captions.map((caption) => caption.id));

    for (const [id, scheduled] of timers) {
      const caption = state.captions.find((candidate) => candidate.id === id);
      if (!activeIds.has(id) || caption?.translation) {
        window.clearTimeout(scheduled.timer);
        timers.delete(id);
      }
    }

    for (const caption of state.captions) {
      if (caption.translation || !caption.sourceText.trim()) continue;
      const signature = `${caption.id}:${caption.sourceText}`;
      const existing = timers.get(caption.id);
      if (existing?.signature === signature) continue;
      if (existing) window.clearTimeout(existing.timer);

      const timer = window.setTimeout(
        () => {
          const scheduled = timers.get(caption.id);
          if (scheduled?.signature !== signature) return;
          timers.delete(caption.id);
          translate(caption.sourceText, liveCaptionSettings(settings))
            .then((result) => {
              dispatch({
                type: 'caption-translation',
                id: caption.id,
                sourceText: caption.sourceText,
                translation: result.translation,
              });
            })
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

  return (
    <div className={`caption-overlay${state.error ? ' has-error' : ''}`}>
      <div className="caption-surface">
        {/* Floating Controls Header */}
        <div className="caption-header">
          <div className="caption-header-left">
            <div
              className="caption-drag-handle"
              data-tauri-drag-region
              title="按住拖拽移动字幕位置"
            >
              <span className="caption-drag-dots">⋮⋮</span>
              <span>Lumen 字幕</span>
            </div>
            {state.appName && (
              <div className="caption-target-badge" title={`正在监听: ${state.appName}`}>
                <span className={`caption-status-dot${hasContent ? '' : ' idle'}`} />
                <span>{state.appName}</span>
              </div>
            )}
          </div>
          <div className="caption-header-right">
            <button
              type="button"
              className={`caption-btn${clickthrough ? ' active' : ''}`}
              onClick={handleToggleClickthrough}
              title={
                clickthrough
                  ? '穿透模式已开启（点击恢复鼠标交互）'
                  : '开启穿透模式（点击穿透到底层）'
              }
            >
              <LockIcon locked={clickthrough} />
            </button>
            <button
              type="button"
              className="caption-btn"
              onClick={handleOpenSettings}
              title="偏好设置 (配置翻译模型 API Key)"
            >
              <SettingsIcon />
            </button>
            <button
              type="button"
              className="caption-btn close"
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
            <div className="caption-flow">
              {visibleCaptions.map((line, index) => (
                <CaptionPair
                  key={line.id}
                  line={line}
                  history={index < visibleCaptions.length - 1}
                />
              ))}
              {state.draft && (
                <div className="caption-block draft" key={`draft-${state.draft.utterance}`}>
                  <div
                    className={`caption-line translation draft-translation${
                      state.draft.translation ? '' : ' placeholder'
                    }`}
                    aria-hidden={!state.draft.translation}
                  >
                    {state.draft.translation ?? ' '}
                  </div>
                  <div className="caption-line original draft-original">
                    <span className="draft-stable">
                      {state.draft.sourceText.slice(0, state.draft.stablePrefixLength)}
                    </span>
                    <span className="draft-mutable">
                      {state.draft.sourceText.slice(state.draft.stablePrefixLength)}
                    </span>
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

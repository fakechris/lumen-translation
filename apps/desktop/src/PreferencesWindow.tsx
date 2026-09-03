/**
 * Preferences — the Windows counterpart of `PreferencesWindow.swift`.
 *
 * Tabs match macOS (AI Provider / Custom / General / About) plus one that has
 * no macOS equivalent: **Selection**, which configures the PopClip replacement
 * (there is nothing to configure on macOS, where PopClip itself owns that).
 *
 * Every edit writes straight through to the Rust-owned settings file, matching
 * the macOS app's `onChange -> Preferences.shared` behaviour: there is no
 * Save/Cancel, and the tray's Engine submenu picks changes up immediately.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { CloseIcon } from './Icons';
import { CATALOG, type ProviderPreset } from './catalog';
import { autoDetectRegion, SOURCE_LANGS, TARGET_LANGS } from './lang';
import {
  allProviders,
  apiKeyFor,
  DEFAULT_SETTINGS,
  endpointFor,
  formatShortcutDisplay,
  isMacOS,
  loadSettings,
  modelFor,
  newCustomProvider,
  onSettingsChanged,
  saveSettings,
  type CustomProvider,
  type Settings,
} from './settings';

type Tab = 'provider' | 'custom' | 'selection' | 'general' | 'about';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'provider', label: 'AI Provider' },
  { id: 'custom', label: 'Custom' },
  { id: 'selection', label: 'Selection' },
  { id: 'general', label: 'General' },
  { id: 'about', label: 'About' },
];

export function PreferencesWindow() {
  const [tab, setTab] = useState<Tab>('provider');
  const [settings, setSettings] = useState<Settings | null>(null);
  const settingsRef = useRef<Settings | null>(null);

  const acceptSettings = (next: Settings) => {
    settingsRef.current = next;
    setSettings(next);
  };

  useEffect(() => {
    loadSettings().then(acceptSettings).catch(console.error);
    const un = onSettingsChanged(acceptSettings);
    return () => {
      un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  // Write-through: apply locally for an instant UI response, then persist.
  const update: SettingsUpdater = (change) => {
    const previous = settingsRef.current;
    if (!previous) return;
    const patch = typeof change === 'function' ? change(previous) : change;
    const next = { ...previous, ...patch };
    acceptSettings(next);
    void saveSettings(next).catch(console.error);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    const nextTab = TABS[next].id;
    setTab(nextTab);
    requestAnimationFrame(() => document.getElementById(`tab-${nextTab}`)?.focus());
  };

  if (!settings) return <div className="prefs" />;

  return (
    <div className="prefs">
      <div className="prefs-titlebar">
        Lumen Translation Settings
        <button
          className="text-button push"
          onClick={() => void getCurrentWindow().hide()}
          title="Close"
        >
          <CloseIcon />
        </button>
      </div>

      <div className="prefs-tabs" role="tablist">
        {TABS.map((t, index) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="prefs-panel"
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="prefs-scroll" id="prefs-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === 'provider' && <ProviderTab s={settings} update={update} />}
        {tab === 'custom' && <CustomTab s={settings} update={update} />}
        {tab === 'selection' && <SelectionTab s={settings} update={update} />}
        {tab === 'general' && <GeneralTab s={settings} update={update} />}
        {tab === 'about' && <AboutTab />}
      </div>
    </div>
  );
}

type SettingsUpdater = (
  change: Partial<Settings> | ((current: Settings) => Partial<Settings>),
) => void;

interface TabProps {
  s: Settings;
  update: SettingsUpdater;
}

// ---------------------------------------------------------------------------
// AI Provider
// ---------------------------------------------------------------------------

type ProbeState =
  { kind: 'idle' } | { kind: 'running' } | { kind: 'ok' } | { kind: 'failed'; message: string };

function ProviderTab({ s, update }: TabProps) {
  const [showKey, setShowKey] = useState(false);
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' });

  const providers = useMemo(() => allProviders(s), [s]);
  const preset = providers.find((p) => p.id === s.providerId) ?? providers[0] ?? CATALOG[0];
  const key = apiKeyFor(s, preset.id);
  const model = modelFor(s, preset.id);

  const setKey = (value: string) => {
    setProbe({ kind: 'idle' });
    update((current) => ({
      apiKeys: { ...current.apiKeys, [preset.id]: value.trim() },
    }));
  };

  const setModel = (value: string) => {
    setProbe({ kind: 'idle' });
    update((current) => ({ models: { ...current.models, [preset.id]: value } }));
  };

  const validate = async () => {
    setProbe({ kind: 'running' });
    const message = await probeProvider(s, preset);
    setProbe(message ? { kind: 'failed', message } : { kind: 'ok' });
  };

  return (
    <>
      <div className="section-title">Provider</div>
      <div className="field">
        <label htmlFor="provider">Provider</label>
        <select
          id="provider"
          value={preset.id}
          onChange={(e) => {
            setProbe({ kind: 'idle' });
            update({ providerId: e.target.value });
          }}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {preset.models.length > 1 && (
        <div className="field">
          <label htmlFor="model">Model</label>
          <select id="model" value={model} onChange={(e) => setModel(e.target.value)}>
            {preset.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      )}

      {preset.needsKey ? (
        <>
          <div className="section-title">API Key</div>
          <div className="field">
            <label htmlFor="apikey">API Key</label>
            <div className="row">
              <input
                id="apikey"
                type={showKey ? 'text' : 'password'}
                value={key}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setKey(e.target.value)}
              />
              <button
                className="text-button"
                onClick={() => setShowKey((v) => !v)}
                title={showKey ? 'Hide key' : 'Show key'}
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          <div className="field">
            <div aria-hidden="true" />
            <div className="row">
              <button
                className="text-button"
                onClick={validate}
                disabled={probe.kind === 'running' || !key}
              >
                {probe.kind === 'running'
                  ? 'Validating…'
                  : probe.kind === 'failed'
                    ? 'Retry'
                    : 'Validate'}
              </button>
              {probe.kind === 'ok' && (
                <span className="probe-result ok">Connected to {preset.label}.</span>
              )}
              {probe.kind === 'failed' && (
                <span className="probe-result fail">{probe.message}</span>
              )}
            </div>
          </div>
          {preset.docsURL && (
            <div className="field">
              <div aria-hidden="true" />
              <div>
                <button className="text-button" onClick={() => void openUrl(preset.docsURL!)}>
                  Get API key ↗
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="hint" style={{ gridColumn: 1 }}>
          No API key required for {preset.label}.
        </p>
      )}
    </>
  );
}

/**
 * Send the smallest possible chat request to confirm the endpoint and key
 * work. Returns an error message, or `null` on success. Mirrors
 * `validateProvider` in `PreferencesWindow.swift`.
 */
async function probeProvider(s: Settings, preset: ProviderPreset): Promise<string | null> {
  const key = apiKeyFor(s, preset.id);
  if (!key) return 'API key is empty.';
  const endpoint = endpointFor(s, preset);
  if (!endpoint) return 'Endpoint is not configured.';
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        ...preset.extraHeaders,
      },
      body: JSON.stringify({
        model: modelFor(s, preset.id),
        temperature: 0,
        messages: [
          { role: 'system', content: 'You are a translation engine. Reply with: ok' },
          { role: 'user', content: 'test' },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return `HTTP ${res.status}: ${body.slice(0, 200)}`;
    }
    return null;
  } catch (err) {
    if (controller.signal.aborted) return 'Request timed out after 10 seconds.';
    return (err as Error).message;
  } finally {
    window.clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Custom OpenAI-compatible endpoint slots
// ---------------------------------------------------------------------------

function CustomTab({ s, update }: TabProps) {
  const patchSlot = (id: string, patch: Partial<CustomProvider>) => {
    update((current) => ({
      customProviders: current.customProviders.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
  };

  const remove = (id: string) => {
    update((current) => {
      const apiKeys = { ...current.apiKeys };
      const models = { ...current.models };
      delete apiKeys[id];
      delete models[id];
      return {
        customProviders: current.customProviders.filter((c) => c.id !== id),
        apiKeys,
        models,
        // Fall back to the default provider if the removed slot was selected.
        providerId: current.providerId === id ? 'google_translate' : current.providerId,
      };
    });
  };

  return (
    <>
      <p className="hint" style={{ gridColumn: 1, margin: '0 0 14px' }}>
        Add OpenAI-compatible endpoints. Each slot keeps its own base URL, model, and API key, and
        shows up in the provider list and the tray's Engine switcher.
      </p>

      {s.customProviders.map((c) => (
        <div className="custom-slot" key={c.id}>
          <div className="field stacked">
            <label>Name</label>
            <input
              type="text"
              value={c.name}
              onChange={(e) => patchSlot(c.id, { name: e.target.value })}
            />
          </div>
          <div className="field stacked">
            <label>Base URL</label>
            <input
              type="text"
              placeholder="https://api.example.com/v1"
              value={c.baseURL}
              spellCheck={false}
              onChange={(e) => patchSlot(c.id, { baseURL: e.target.value })}
            />
          </div>
          <div className="field stacked">
            <label>Model</label>
            <input
              type="text"
              value={c.model}
              spellCheck={false}
              onChange={(e) => patchSlot(c.id, { model: e.target.value })}
            />
          </div>
          <div className="field stacked">
            <label>API Key</label>
            <input
              type="password"
              value={s.apiKeys[c.id] ?? ''}
              autoComplete="off"
              onChange={(e) =>
                update((current) => ({
                  apiKeys: { ...current.apiKeys, [c.id]: e.target.value.trim() },
                }))
              }
            />
          </div>
          <div className="row" style={{ paddingBottom: 10 }}>
            <button className="text-button danger" onClick={() => remove(c.id)}>
              Delete slot
            </button>
          </div>
        </div>
      ))}

      <button
        className="text-button"
        onClick={() =>
          update((current) => ({
            customProviders: [...current.customProviders, newCustomProvider()],
          }))
        }
      >
        + Add custom endpoint
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Selection watcher (no macOS equivalent — PopClip owns this there)
// ---------------------------------------------------------------------------

function SelectionTab({ s, update }: TabProps) {
  const [minText, setMinText] = useState(String(s.minSelectionChars));
  const [maxText, setMaxText] = useState(String(s.maxSelectionChars));

  useEffect(() => setMinText(String(s.minSelectionChars)), [s.minSelectionChars]);
  useEffect(() => setMaxText(String(s.maxSelectionChars)), [s.maxSelectionChars]);

  const commitMin = () => {
    const parsed = Number.parseInt(minText, 10);
    const value = Math.min(100, Math.max(1, Number.isFinite(parsed) ? parsed : 1));
    setMinText(String(value));
    update((current) => ({
      minSelectionChars: value,
      maxSelectionChars: Math.max(value, current.maxSelectionChars),
    }));
  };

  const commitMax = () => {
    const parsed = Number.parseInt(maxText, 10);
    const bounded = Math.min(100000, Math.max(100, Number.isFinite(parsed) ? parsed : 5000));
    const value = Math.max(s.minSelectionChars, bounded);
    setMaxText(String(value));
    update({ maxSelectionChars: value });
  };

  return (
    <>
      <p className="hint" style={{ gridColumn: 1, margin: '0 0 14px' }}>
        Windows has no PopClip, so Lumen watches for text selections itself and shows a small action
        bar next to the cursor.
      </p>

      <div className="section-title">Action bar</div>
      <div className="field check">
        <label htmlFor="popup">Show action bar on selection</label>
        <div>
          <input
            id="popup"
            type="checkbox"
            checked={s.selectionPopupEnabled}
            onChange={(e) => update({ selectionPopupEnabled: e.target.checked })}
          />
        </div>
      </div>
      <div className="field check">
        <label htmlFor="fallback">Use clipboard fallback</label>
        <div>
          <input
            id="fallback"
            type="checkbox"
            checked={s.selectionClipboardFallback}
            onChange={(e) => update({ selectionClipboardFallback: e.target.checked })}
          />
        </div>
      </div>
      <p className="hint">
        When an app exposes no accessible text (some games, remote desktops, old Win32 controls),
        Lumen presses Ctrl+C for you and restores whatever was on the clipboard afterwards. Turn
        this off to leave the clipboard strictly untouched.
      </p>

      <div className="field">
        <label htmlFor="minchars">Minimum selection length</label>
        <input
          id="minchars"
          type="number"
          min={1}
          max={100}
          value={minText}
          onChange={(e) => setMinText(e.target.value)}
          onBlur={commitMin}
        />
      </div>
      <div className="field">
        <label htmlFor="maxchars">Maximum characters translated</label>
        <input
          id="maxchars"
          type="number"
          min={100}
          max={100000}
          value={maxText}
          onChange={(e) => setMaxText(e.target.value)}
          onBlur={commitMax}
        />
      </div>

      <div className="section-title">Shortcuts</div>
      <div className="field">
        <label htmlFor="hk-translate">Translate selection</label>
        <ShortcutRecorder
          id="hk-translate"
          value={s.hotkeyTranslateSelection}
          defaultValue={DEFAULT_SETTINGS.hotkeyTranslateSelection}
          onChange={(hotkeyTranslateSelection) => update({ hotkeyTranslateSelection })}
        />
      </div>
      <div className="field">
        <label htmlFor="hk-clipboard">Translate clipboard</label>
        <ShortcutRecorder
          id="hk-clipboard"
          value={s.hotkeyTranslateClipboard}
          defaultValue={DEFAULT_SETTINGS.hotkeyTranslateClipboard}
          onChange={(hotkeyTranslateClipboard) => update({ hotkeyTranslateClipboard })}
        />
      </div>
      <div className="field">
        <label htmlFor="hk-last">Show last translation</label>
        <ShortcutRecorder
          id="hk-last"
          value={s.hotkeyShowLast}
          defaultValue={DEFAULT_SETTINGS.hotkeyShowLast}
          onChange={(hotkeyShowLast) => update({ hotkeyShowLast })}
        />
      </div>
      <p className="hint">
        Click a shortcut to record keys directly (e.g. ⌥⌘L / ⇧⌘K). Press Escape to cancel, Backspace to clear.
      </p>
    </>
  );
}

function isModifierKey(code: string, key: string): boolean {
  return (
    ['Meta', 'Alt', 'Control', 'Shift', 'AltGraph', 'OS'].includes(key) ||
    [
      'MetaLeft',
      'MetaRight',
      'AltLeft',
      'AltRight',
      'ControlLeft',
      'ControlRight',
      'ShiftLeft',
      'ShiftRight',
      'OSLeft',
      'OSRight',
    ].includes(code)
  );
}

function getModifiers(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string[] {
  const isMac = isMacOS();
  const modifiers: string[] = [];
  if (isMac) {
    if (e.ctrlKey) modifiers.push('Control');
    if (e.altKey) modifiers.push('Option');
    if (e.shiftKey) modifiers.push('Shift');
    if (e.metaKey) modifiers.push('Command');
  } else {
    if (e.ctrlKey) modifiers.push('Ctrl');
    if (e.altKey) modifiers.push('Alt');
    if (e.shiftKey) modifiers.push('Shift');
    if (e.metaKey) modifiers.push('Super');
  }
  return modifiers;
}

function resolveKeyName(code: string, key: string): string {
  if (code.startsWith('Key')) {
    return code.slice(3).toUpperCase();
  }
  if (code.startsWith('Digit')) {
    return code.slice(5);
  }
  if (code.startsWith('Numpad') && /^Numpad\d$/.test(code)) {
    return code.slice(6);
  }
  if (/^F\d+$/.test(code)) {
    return code;
  }

  switch (code) {
    case 'Space':
      return 'Space';
    case 'Enter':
    case 'NumpadEnter':
      return 'Enter';
    case 'Tab':
      return 'Tab';
    case 'Backquote':
      return '`';
    case 'Minus':
    case 'NumpadSubtract':
      return '-';
    case 'Equal':
    case 'NumpadEqual':
      return '=';
    case 'BracketLeft':
      return '[';
    case 'BracketRight':
      return ']';
    case 'Backslash':
      return '\\';
    case 'Semicolon':
      return ';';
    case 'Quote':
      return "'";
    case 'Comma':
      return ',';
    case 'Period':
    case 'NumpadDecimal':
      return '.';
    case 'Slash':
    case 'NumpadDivide':
      return '/';
    case 'ArrowUp':
      return 'Up';
    case 'ArrowDown':
      return 'Down';
    case 'ArrowLeft':
      return 'Left';
    case 'ArrowRight':
      return 'Right';
    case 'Home':
      return 'Home';
    case 'End':
      return 'End';
    case 'PageUp':
      return 'PageUp';
    case 'PageDown':
      return 'PageDown';
    case 'Insert':
      return 'Insert';
  }

  if (key && key.length === 1 && /^[\x20-\x7E]$/.test(key)) {
    return key.toUpperCase();
  }

  return '';
}

function ShortcutRecorder({
  id,
  value,
  defaultValue,
  onChange,
}: {
  id?: string;
  value: string;
  defaultValue?: string;
  onChange: (value: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [heldModifiers, setHeldModifiers] = useState<string[]>([]);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!recording) return;

    buttonRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape' || e.code === 'Escape') {
        setRecording(false);
        setHeldModifiers([]);
        return;
      }

      if (
        (e.key === 'Backspace' || e.key === 'Delete' || e.code === 'Backspace' || e.code === 'Delete') &&
        !e.metaKey &&
        !e.altKey &&
        !e.ctrlKey &&
        !e.shiftKey
      ) {
        onChange('');
        setRecording(false);
        setHeldModifiers([]);
        return;
      }

      if (e.key === 'Tab' && !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        setRecording(false);
        setHeldModifiers([]);
        return;
      }

      const modifiers = getModifiers(e);

      if (isModifierKey(e.code, e.key)) {
        setHeldModifiers(modifiers);
        return;
      }

      const keyName = resolveKeyName(e.code, e.key);
      if (!keyName) return;

      const isFunctionKey = /^F\d+$/.test(keyName);
      if (!isFunctionKey && modifiers.length === 0) {
        return;
      }

      const accelerator = [...modifiers, keyName].join('+');
      onChange(accelerator);
      setRecording(false);
      setHeldModifiers([]);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setHeldModifiers(getModifiers(e));
    };

    const handlePointerDown = (e: MouseEvent) => {
      if (buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        setRecording(false);
        setHeldModifiers([]);
      }
    };

    const handleBlur = () => {
      setRecording(false);
      setHeldModifiers([]);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, [recording, onChange]);

  const displayText = useMemo(() => {
    if (recording) {
      if (heldModifiers.length > 0) {
        return formatShortcutDisplay(heldModifiers.join('+')) + '...';
      }
      return 'Press shortcut keys...';
    }
    if (!value) return 'None (Click to record)';
    return formatShortcutDisplay(value);
  }, [recording, heldModifiers, value]);

  return (
    <div className="shortcut-recorder-wrap">
      <button
        id={id}
        ref={buttonRef}
        type="button"
        className={`shortcut-recorder ${recording ? 'recording' : ''}`}
        onClick={(e) => {
          e.preventDefault();
          setRecording((prev) => !prev);
          setHeldModifiers([]);
        }}
        title={recording ? 'Press your shortcut combination or Esc to cancel' : 'Click to record a new shortcut'}
      >
        <span className={recording ? 'shortcut-recording-text' : (value ? 'shortcut-display' : 'shortcut-placeholder')}>
          {displayText}
        </span>
        {value && !recording && (
          <span
            className="shortcut-clear-btn"
            title="Clear shortcut"
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
            }}
          >
            ×
          </span>
        )}
      </button>
      {defaultValue && value !== defaultValue && (
        <button
          type="button"
          className="text-button"
          style={{ padding: '3px 7px', fontSize: '11px', flexShrink: 0 }}
          title={`Reset to default (${formatShortcutDisplay(defaultValue)})`}
          onClick={() => onChange(defaultValue)}
        >
          Reset
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

function GeneralTab({ s, update }: TabProps) {
  const providers = allProviders(s);
  const preset = providers.find((p) => p.id === s.providerId) ?? CATALOG[0];
  const detected = autoDetectRegion();

  return (
    <>
      <div className="section-title">Live subtitles</div>
      <div className="field">
        <label htmlFor="subtitle-capture">Audio capture</label>
        <select
          id="subtitle-capture"
          value={s.liveSubtitleCaptureMode}
          onChange={(e) =>
            update({
              liveSubtitleCaptureMode: e.target.value as Settings['liveSubtitleCaptureMode'],
            })
          }
        >
          <option value="allSystemAudio">All system audio (recommended)</option>
          <option value="frontmostApp">Frontmost app at start only</option>
        </select>
      </div>
      <p className="hint">
        macOS only. All system audio keeps captions running when the player or meeting app is in the
        background, and also hears apps that start playing later. Frontmost-only limits capture to
        the app selected when subtitles start. Changes apply to the next subtitle session.
      </p>

      <div className="section-title">Endpoint region</div>
      <div className="field">
        <label htmlFor="region">Region</label>
        <select
          id="region"
          value={s.region ?? 'auto'}
          onChange={(e) =>
            update({
              region: e.target.value === 'auto' ? null : (e.target.value as 'cn' | 'overseas'),
            })
          }
        >
          <option value="auto">Auto (system locale / timezone)</option>
          <option value="cn">China 国内</option>
          <option value="overseas">Overseas 海外</option>
        </select>
      </div>
      <p className="hint">
        {preset.endpointOverseas
          ? `Detected: ${detected === 'cn' ? 'China' : 'Overseas'}`
          : 'This provider has a single global endpoint; region has no effect.'}
      </p>

      <div className="section-title">Languages</div>
      <div className="field">
        <label htmlFor="source">Source</label>
        <select
          id="source"
          value={s.sourceLang}
          onChange={(e) => update({ sourceLang: e.target.value })}
        >
          {SOURCE_LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="target">Target</label>
        <select
          id="target"
          value={s.targetLang}
          onChange={(e) => update({ targetLang: e.target.value })}
        >
          {TARGET_LANGS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      <div className="section-title">Startup</div>
      <div className="field check">
        <label htmlFor="autostart">Launch at login</label>
        <div>
          <input
            id="autostart"
            type="checkbox"
            checked={s.launchAtLogin}
            onChange={(e) => update({ launchAtLogin: e.target.checked })}
          />
        </div>
      </div>
      {isMacOS() && (
        <div className="field check">
          <label htmlFor="dock-icon">Show icon in Dock</label>
          <div>
            <input
              id="dock-icon"
              type="checkbox"
              checked={s.showDockIcon}
              onChange={(e) => update({ showDockIcon: e.target.checked })}
            />
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

const REPO = 'https://github.com/fakechris/lumen-translation';

function AboutTab() {
  const [version, setVersion] = useState('…');
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => undefined);
  }, []);

  return (
    <div style={{ textAlign: 'center', paddingTop: 20 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>Lumen Translation</h2>
      <p className="hint" style={{ gridColumn: 1, margin: 0 }}>
        Version {version}
      </p>
      <p className="hint" style={{ gridColumn: 1, margin: '4px 0 18px' }}>
        Open-source bilingual translation
      </p>
      <div className="row" style={{ justifyContent: 'center', gap: 10 }}>
        <button className="text-button" onClick={() => void openUrl(REPO)}>
          GitHub ↗
        </button>
        <button className="text-button" onClick={() => void openUrl(`${REPO}/issues`)}>
          Report an issue ↗
        </button>
      </div>
    </div>
  );
}

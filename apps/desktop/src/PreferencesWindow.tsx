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

import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CloseIcon } from "./Icons";
import { CATALOG, type ProviderPreset } from "./catalog";
import { autoDetectRegion, SOURCE_LANGS, TARGET_LANGS } from "./lang";
import {
  allProviders,
  apiKeyFor,
  endpointFor,
  loadSettings,
  modelFor,
  newCustomProvider,
  onSettingsChanged,
  saveSettings,
  type CustomProvider,
  type Settings,
} from "./settings";

type Tab = "provider" | "custom" | "selection" | "general" | "about";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "provider", label: "AI Provider" },
  { id: "custom", label: "Custom" },
  { id: "selection", label: "Selection" },
  { id: "general", label: "General" },
  { id: "about", label: "About" },
];

export function PreferencesWindow() {
  const [tab, setTab] = useState<Tab>("provider");
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    loadSettings().then(setSettings).catch(console.error);
    const un = onSettingsChanged(setSettings);
    return () => {
      un.then((f) => f()).catch(() => undefined);
    };
  }, []);

  // Write-through: apply locally for an instant UI response, then persist.
  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      void saveSettings(next).catch(console.error);
      return next;
    });
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
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="prefs-scroll">
        {tab === "provider" && <ProviderTab s={settings} update={update} />}
        {tab === "custom" && <CustomTab s={settings} update={update} />}
        {tab === "selection" && <SelectionTab s={settings} update={update} />}
        {tab === "general" && <GeneralTab s={settings} update={update} />}
        {tab === "about" && <AboutTab />}
      </div>
    </div>
  );
}

interface TabProps {
  s: Settings;
  update: (patch: Partial<Settings>) => void;
}

// ---------------------------------------------------------------------------
// AI Provider
// ---------------------------------------------------------------------------

type ProbeState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok" }
  | { kind: "failed"; message: string };

function ProviderTab({ s, update }: TabProps) {
  const [showKey, setShowKey] = useState(false);
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });

  const providers = useMemo(() => allProviders(s), [s]);
  const preset =
    providers.find((p) => p.id === s.providerId) ?? providers[0] ?? CATALOG[0];
  const key = apiKeyFor(s, preset.id);
  const model = modelFor(s, preset.id);

  const setKey = (value: string) => {
    setProbe({ kind: "idle" });
    update({ apiKeys: { ...s.apiKeys, [preset.id]: value.trim() } });
  };

  const setModel = (value: string) => {
    setProbe({ kind: "idle" });
    update({ models: { ...s.models, [preset.id]: value } });
  };

  const validate = async () => {
    setProbe({ kind: "running" });
    const message = await probeProvider(s, preset);
    setProbe(message ? { kind: "failed", message } : { kind: "ok" });
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
            setProbe({ kind: "idle" });
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
          <select
            id="model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
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
                type={showKey ? "text" : "password"}
                value={key}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setKey(e.target.value)}
              />
              <button
                className="text-button"
                onClick={() => setShowKey((v) => !v)}
                title={showKey ? "Hide key" : "Show key"}
              >
                {showKey ? "Hide" : "Show"}
              </button>
            </div>
          </div>
          <div className="field">
            <label />
            <div className="row">
              <button
                className="text-button"
                onClick={validate}
                disabled={probe.kind === "running" || !key}
              >
                {probe.kind === "running"
                  ? "Validating…"
                  : probe.kind === "failed"
                    ? "Retry"
                    : "Validate"}
              </button>
              {probe.kind === "ok" && (
                <span className="probe-result ok">
                  Connected to {preset.label}.
                </span>
              )}
              {probe.kind === "failed" && (
                <span className="probe-result fail">{probe.message}</span>
              )}
            </div>
          </div>
          {preset.docsURL && (
            <div className="field">
              <label />
              <div>
                <button
                  className="text-button"
                  onClick={() => void openUrl(preset.docsURL!)}
                >
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
async function probeProvider(
  s: Settings,
  preset: ProviderPreset,
): Promise<string | null> {
  const key = apiKeyFor(s, preset.id);
  if (!key) return "API key is empty.";
  const endpoint = endpointFor(s, preset);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        ...preset.extraHeaders,
      },
      body: JSON.stringify({
        model: modelFor(s, preset.id),
        temperature: 0,
        messages: [
          { role: "system", content: "You are a translation engine. Reply with: ok" },
          { role: "user", content: "test" },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return `HTTP ${res.status}: ${body.slice(0, 200)}`;
    }
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

// ---------------------------------------------------------------------------
// Custom OpenAI-compatible endpoint slots
// ---------------------------------------------------------------------------

function CustomTab({ s, update }: TabProps) {
  const patchSlot = (id: string, patch: Partial<CustomProvider>) => {
    update({
      customProviders: s.customProviders.map((c) =>
        c.id === id ? { ...c, ...patch } : c,
      ),
    });
  };

  const remove = (id: string) => {
    const apiKeys = { ...s.apiKeys };
    const models = { ...s.models };
    delete apiKeys[id];
    delete models[id];
    update({
      customProviders: s.customProviders.filter((c) => c.id !== id),
      apiKeys,
      models,
      // Fall back to the default provider if the removed slot was selected.
      providerId: s.providerId === id ? "google_translate" : s.providerId,
    });
  };

  return (
    <>
      <p className="hint" style={{ gridColumn: 1, margin: "0 0 14px" }}>
        Add OpenAI-compatible endpoints. Each slot keeps its own base URL,
        model, and API key, and shows up in the provider list and the tray's
        Engine switcher.
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
              value={s.apiKeys[c.id] ?? ""}
              autoComplete="off"
              onChange={(e) =>
                update({ apiKeys: { ...s.apiKeys, [c.id]: e.target.value.trim() } })
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
          update({ customProviders: [...s.customProviders, newCustomProvider()] })
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
  return (
    <>
      <p className="hint" style={{ gridColumn: 1, margin: "0 0 14px" }}>
        Windows has no PopClip, so Lumen watches for text selections itself and
        shows a small action bar next to the cursor.
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
            onChange={(e) =>
              update({ selectionClipboardFallback: e.target.checked })
            }
          />
        </div>
      </div>
      <p className="hint">
        When an app exposes no accessible text (some games, remote desktops, old
        Win32 controls), Lumen presses Ctrl+C for you and restores whatever was
        on the clipboard afterwards. Turn this off to leave the clipboard
        strictly untouched.
      </p>

      <div className="field">
        <label htmlFor="minchars">Minimum selection length</label>
        <input
          id="minchars"
          type="number"
          min={1}
          max={100}
          value={s.minSelectionChars}
          onChange={(e) =>
            update({ minSelectionChars: Math.max(1, Number(e.target.value) || 1) })
          }
        />
      </div>
      <div className="field">
        <label htmlFor="maxchars">Maximum characters translated</label>
        <input
          id="maxchars"
          type="number"
          min={100}
          max={100000}
          value={s.maxSelectionChars}
          onChange={(e) =>
            update({
              maxSelectionChars: Math.max(100, Number(e.target.value) || 5000),
            })
          }
        />
      </div>

      <div className="section-title">Shortcuts</div>
      <div className="field">
        <label htmlFor="hk-translate">Translate selection</label>
        <input
          id="hk-translate"
          type="text"
          spellCheck={false}
          value={s.hotkeyTranslateSelection}
          onChange={(e) => update({ hotkeyTranslateSelection: e.target.value })}
        />
      </div>
      <div className="field">
        <label htmlFor="hk-last">Show last translation</label>
        <input
          id="hk-last"
          type="text"
          spellCheck={false}
          value={s.hotkeyShowLast}
          onChange={(e) => update({ hotkeyShowLast: e.target.value })}
        />
      </div>
      <p className="hint">
        Tauri accelerator syntax, e.g. <code>Alt+Ctrl+T</code> or{" "}
        <code>Shift+Super+Y</code>. Invalid or already-claimed combinations are
        reported in the tray tooltip.
      </p>
    </>
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
      <div className="section-title">Endpoint region</div>
      <div className="field">
        <label htmlFor="region">Region</label>
        <select
          id="region"
          value={s.region ?? "auto"}
          onChange={(e) =>
            update({
              region:
                e.target.value === "auto"
                  ? null
                  : (e.target.value as "cn" | "overseas"),
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
          ? `Detected: ${detected === "cn" ? "China" : "Overseas"}`
          : "This provider has a single global endpoint; region has no effect."}
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
    </>
  );
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

const REPO = "https://github.com/fakechris/lumen-translation";

function AboutTab() {
  const [version, setVersion] = useState("…");
  useEffect(() => {
    getVersion().then(setVersion).catch(() => undefined);
  }, []);

  return (
    <div style={{ textAlign: "center", paddingTop: 20 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>Lumen Translation</h2>
      <p className="hint" style={{ gridColumn: 1, margin: 0 }}>
        Version {version}
      </p>
      <p className="hint" style={{ gridColumn: 1, margin: "4px 0 18px" }}>
        Open-source bilingual translation
      </p>
      <div className="row" style={{ justifyContent: "center", gap: 10 }}>
        <button className="text-button" onClick={() => void openUrl(REPO)}>
          GitHub ↗
        </button>
        <button
          className="text-button"
          onClick={() => void openUrl(`${REPO}/issues`)}
        >
          Report an issue ↗
        </button>
      </div>
    </div>
  );
}

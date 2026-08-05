/**
 * Settings — the Windows counterpart of `Preferences.swift`.
 *
 * macOS keeps these in `UserDefaults`. Here the Rust side owns a JSON file
 * under `%APPDATA%\Lumen Translation\settings.json` (API keys encrypted with
 * DPAPI) because the backend needs them too: the tray's Engine submenu writes
 * `providerId`, and the selection watcher reads its own toggles. Windows stay
 * in sync through the `settings-changed` event.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CATALOG, findProvider, type ProviderPreset } from "./catalog";
import { autoDetectRegion } from "./lang";

/**
 * A user-defined OpenAI-compatible endpoint slot. The `id` is always prefixed
 * `custom:` so it can never collide with a catalog id.
 */
export interface CustomProvider {
  id: string;
  name: string;
  baseURL: string;
  model: string;
}

export interface Settings {
  providerId: string;
  /** Per-provider API keys, keyed by canonical provider id. */
  apiKeys: Record<string, string>;
  /** Per-provider model overrides, keyed by canonical provider id. */
  models: Record<string, string>;
  /** `null` means auto-detect. */
  region: "cn" | "overseas" | null;
  sourceLang: string;
  targetLang: string;
  customProviders: CustomProvider[];
  /** Whether the selection watcher shows the action bar (the PopClip role). */
  selectionPopupEnabled: boolean;
  /**
   * Whether the action bar may fall back to synthesising Ctrl+C when UI
   * Automation can't read the selection. Invasive but necessary in apps with
   * no accessible text pattern; the previous clipboard contents are restored.
   */
  selectionClipboardFallback: boolean;
  /** Selections shorter than this never raise the action bar. */
  minSelectionChars: number;
  /** Selections longer than this are truncated before translating. */
  maxSelectionChars: number;
  launchAtLogin: boolean;
  /** Re-show the last translation. Tauri accelerator syntax. */
  hotkeyShowLast: string;
  /** Translate the current selection without going through the action bar. */
  hotkeyTranslateSelection: string;
}

export const DEFAULT_SETTINGS: Settings = {
  providerId: "google_translate",
  apiKeys: {},
  models: {},
  region: null,
  sourceLang: "auto",
  targetLang: "zh-CN",
  customProviders: [],
  selectionPopupEnabled: true,
  selectionClipboardFallback: true,
  minSelectionChars: 1,
  maxSelectionChars: 5000,
  launchAtLogin: false,
  hotkeyShowLast: "Alt+Ctrl+L",
  hotkeyTranslateSelection: "Alt+Ctrl+T",
};

export async function loadSettings(): Promise<Settings> {
  const s = await invoke<Settings>("get_settings");
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await invoke("save_settings", { settings });
}

/** Subscribe to changes made in any window or by the tray menu. */
export async function onSettingsChanged(
  fn: (s: Settings) => void,
): Promise<() => void> {
  return listen<Settings>("settings-changed", (e) =>
    fn({ ...DEFAULT_SETTINGS, ...e.payload }),
  );
}

// ---------------------------------------------------------------------------
// Derived views — the accessor half of Preferences.swift.
// ---------------------------------------------------------------------------

/** Canonical catalog id for any saved/incoming id. Custom slots pass through. */
export function canonicalId(id: string): string {
  return findProvider(id)?.id ?? id;
}

/**
 * Adapter view of a custom slot as a `ProviderPreset`, so translation and
 * fallback treat it like any other OpenAI-compatible provider.
 */
export function customPreset(c: CustomProvider): ProviderPreset {
  return {
    id: c.id,
    label: c.name || "Custom Endpoint",
    apiStyle: "openai_compat",
    endpointCN: normalizeChatEndpoint(c.baseURL),
    defaultModel: c.model,
    models: c.model ? [c.model] : [],
    needsKey: true,
    extraHeaders: {},
    aliases: [],
  };
}

/** Built-in catalog providers followed by the user's custom slots. */
export function allProviders(s: Settings): ProviderPreset[] {
  return [...CATALOG, ...s.customProviders.map(customPreset)];
}

/**
 * Resolve an id against the catalog *and* the user's custom slots. Custom
 * slots are only known at runtime, so `findProvider` alone can't see them.
 */
export function findProviderOrCustom(
  s: Settings,
  id: string,
): ProviderPreset | undefined {
  const custom = s.customProviders.find((c) => c.id === id);
  return custom ? customPreset(custom) : findProvider(id);
}

/** The selected provider, falling back to the first catalog entry. */
export function activeProvider(s: Settings): ProviderPreset {
  return findProviderOrCustom(s, s.providerId) ?? CATALOG[0];
}

/**
 * Accept either a base URL (`https://host/v1`) or a full chat-completions URL
 * and normalize to the chat-completions endpoint.
 */
export function normalizeChatEndpoint(raw: string): string {
  let s = raw.trim();
  while (s.endsWith("/")) s = s.slice(0, -1);
  if (s.toLowerCase().endsWith("/chat/completions")) return s;
  return `${s}/chat/completions`;
}

export function effectiveRegion(s: Settings): "cn" | "overseas" {
  return s.region ?? autoDetectRegion();
}

/**
 * Trimmed on read as well as write, so keys stored by older builds — or pasted
 * with a trailing newline — don't produce a malformed `Bearer` header.
 */
export function apiKeyFor(s: Settings, providerId: string): string {
  return (s.apiKeys[canonicalId(providerId)] ?? "").trim();
}

export function modelFor(s: Settings, providerId: string): string {
  const id = canonicalId(providerId);
  const saved = s.models[id];
  if (saved) return saved;
  return (
    findProvider(id)?.defaultModel ??
    s.customProviders.find((c) => c.id === id)?.model ??
    ""
  );
}

/** Resolve the endpoint for a provider given the effective region. */
export function endpointFor(s: Settings, preset: ProviderPreset): string {
  if (effectiveRegion(s) === "overseas" && preset.endpointOverseas) {
    return preset.endpointOverseas;
  }
  return preset.endpointCN;
}

export function newCustomProvider(): CustomProvider {
  return {
    id: `custom:${crypto.randomUUID()}`,
    name: "New endpoint",
    baseURL: "",
    model: "",
  };
}

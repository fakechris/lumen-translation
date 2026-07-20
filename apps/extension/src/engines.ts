import type { Engine, Settings } from "@lumen/core";
import { getEngineConfig } from "@lumen/core";
import {
  createGoogleEngine,
  createMicrosoftEngine,
  createDeepLEngine,
  createOpenAIEngine,
  createOllamaEngine,
  createProviderEngine,
  getProviderPreset,
  PROVIDER_CATALOG,
} from "@lumen/engines";

/**
 * Build an Engine instance from the user's settings. Unknown engine ids fall
 * back to the free Google engine so the extension is always usable.
 */
export function buildEngine(settings: Settings): Engine {
  const id = settings.activeEngineId;
  const cfg = getEngineConfig(settings, id);

  switch (id) {
    case "google":
      return createGoogleEngine(cfg as { endpoint?: string });
    case "microsoft":
      return createMicrosoftEngine(cfg as { endpoint?: string });
    case "deepl":
      return createDeepLEngine({
        apiKey: String(cfg.apiKey ?? ""),
        pro: Boolean(cfg.pro),
        endpoint: cfg.endpoint as string | undefined,
      });
    case "openai":
      return createOpenAIEngine({
        apiKey: cfg.apiKey as string | undefined,
        endpoint: cfg.endpoint as string | undefined,
        model: cfg.model as string | undefined,
        temperature: cfg.temperature as number | undefined,
        headers: cfg.headers as Record<string, string> | undefined,
      });
    case "ollama":
      return createOllamaEngine({
        baseUrl: cfg.baseUrl as string | undefined,
        model: cfg.model as string | undefined,
      });
    default: {
      // Built-in provider presets (deepseek, glm, kimi, minimax, doubao, ...).
      const engine = createProviderEngine(id, {
        apiKey: cfg.apiKey as string | undefined,
        model: cfg.model as string | undefined,
        region: cfg.region as "cn" | "overseas" | undefined,
        endpoint: cfg.endpoint as string | undefined,
      });
      return engine ?? createGoogleEngine();
    }
  }
}

export interface EngineCatalogEntry {
  id: string;
  label: string;
  needsKey: boolean;
  /** Models offered, for UI dropdowns. Empty for engines with free-text model. */
  models?: string[];
  /** Whether this engine supports region selection (domestic/overseas). */
  hasRegion?: boolean;
  /** Whether the engine is free (no key, no setup). */
  free?: boolean;
  /** Group for UI organization. */
  group: "free" | "classic" | "llm-cn" | "llm-overseas" | "local";
  /** Documentation URL for getting a key. */
  docs?: string;
}

const FREE_ENGINES: EngineCatalogEntry[] = [
  { id: "google", label: "Google Translate", needsKey: false, free: true, group: "free" },
  { id: "microsoft", label: "Microsoft Translator", needsKey: false, free: true, group: "free" },
];

const CLASSIC_ENGINES: EngineCatalogEntry[] = [
  { id: "deepl", label: "DeepL", needsKey: true, group: "classic", docs: "https://www.deepl.com/pro-api" },
];

const LOCAL_ENGINES: EngineCatalogEntry[] = [
  { id: "ollama", label: "Ollama (local)", needsKey: false, group: "local" },
  { id: "openai", label: "OpenAI / Compatible (custom)", needsKey: true, group: "local" },
];

const LLM_ENTRIES: EngineCatalogEntry[] = PROVIDER_CATALOG.map((p) => ({
  id: p.id,
  label: p.label,
  needsKey: p.needsKey,
  models: p.models,
  hasRegion: Boolean(p.overseasEndpoint),
  group: p.id === "openrouter" ? "llm-overseas" : "llm-cn",
  docs: p.docs,
}));

export const ENGINE_CATALOG: EngineCatalogEntry[] = [
  ...FREE_ENGINES,
  ...CLASSIC_ENGINES,
  ...LLM_ENTRIES,
  ...LOCAL_ENGINES,
];

export const ENGINE_GROUPS: { id: EngineCatalogEntry["group"]; label: string }[] = [
  { id: "free", label: "Free (no key)" },
  { id: "classic", label: "Classic MT" },
  { id: "llm-cn", label: "LLM · China" },
  { id: "llm-overseas", label: "LLM · Overseas" },
  { id: "local", label: "Local / Custom" },
];

export function getCatalogEntry(id: string): EngineCatalogEntry | undefined {
  return ENGINE_CATALOG.find((e) => e.id === id);
}

export { getProviderPreset };

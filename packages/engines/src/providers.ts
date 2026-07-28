import type { Engine } from "@lumen/core";
import { createOpenAIEngine, type OpenAIEngineOptions } from "./openai.js";
import rawCatalog from "./provider-catalog.v1.json";

/**
 * Built-in LLM provider presets, derived from the Lumen product-suite
 * provider catalog contract (`lumen.provider-catalog/v1`).
 *
 * The vendored `provider-catalog.v1.json` is a byte-for-byte copy of the
 * canonical file in the lumen-suite repo
 * (https://github.com/fakechris/lumen-suite/blob/main/contracts/provider-catalog.v1.json).
 * Do NOT hand-edit it — run `node scripts/sync-provider-catalog.mjs` to pull
 * the latest copy. `PROVIDER_CATALOG` below is a filtered adapter view of that
 * JSON; provider data (endpoints, default models, auth, quirks) must never be
 * hardcoded here again.
 *
 * All exposed presets are OpenAI-compatible chat-completions endpoints, so
 * they are thin wrappers over {@link createOpenAIEngine} that pre-fill the
 * endpoint and a sensible default model. Users only need to supply an API key.
 *
 * For providers with separate domestic / overseas endpoints (MiniMax, GLM,
 * SiliconFlow), pick the endpoint via the `region` option.
 */

// ---------------------------------------------------------------------------
// Catalog JSON shape (subset of contracts/provider-catalog.schema.json that
// this adapter consumes).
// ---------------------------------------------------------------------------

interface CatalogEndpoint {
  base_url: string;
  notes?: string;
}

interface CatalogNoThinking {
  strategy: string;
  body_params: Record<string, unknown>;
  /** Case-insensitive substrings; inject only when the model name matches. */
  model_filter?: string[];
  notes?: string;
}

interface CatalogQuirks {
  no_thinking?: CatalogNoThinking;
  thinking_not_disableable_models?: string[];
  strip_thinking_tags?: boolean;
  legacy_endpoints?: Record<string, string>;
  attribution_headers_configurable?: boolean;
  notes?: string;
}

export interface CatalogProvider {
  id: string;
  aliases?: string[];
  display_name: { en: string; zh?: string };
  api_style: string;
  region: "cn" | "global" | "both" | "local";
  capabilities: string[];
  endpoints?: {
    cn?: CatalogEndpoint;
    global?: CatalogEndpoint;
    local?: CatalogEndpoint;
  };
  chat_path?: string;
  default_model?: string;
  models?: string[];
  needs_key: boolean;
  auth?: { header: string; value_template: string };
  extra_headers?: Record<string, string>;
  docs_url?: string;
  quirks?: CatalogQuirks;
  notes?: string;
}

export interface ProviderCatalogFile {
  spec: string;
  version: string;
  providers: CatalogProvider[];
}

/** The full vendored catalog file (all 26 providers, unfiltered). */
export const PROVIDER_CATALOG_SOURCE: ProviderCatalogFile =
  rawCatalog as unknown as ProviderCatalogFile;

// ---------------------------------------------------------------------------
// Adapter: catalog entry -> ProviderPreset (public API shape is unchanged).
// ---------------------------------------------------------------------------

export interface ProviderPreset {
  id: string;
  label: string;
  /** Domestic (mainland China) endpoint. */
  endpoint: string;
  /** Optional overseas endpoint, used when `region: "overseas"`. */
  overseasEndpoint?: string;
  /** Default model. */
  model: string;
  /** Models offered by the provider, for UI dropdowns. */
  models: string[];
  /** Whether an API key is required. */
  needsKey: boolean;
  /** Auth header name (default "Authorization"). */
  authHeader?: string;
  /** Auth header value template, `{key}` is replaced. Default `Bearer {key}`. */
  authTemplate?: string;
  /** Optional extra headers (e.g. for OpenRouter-style routing). */
  headers?: Record<string, string>;
  /** Documentation / where to get a key. */
  docs?: string;
  /** Catalog region: cn / global / both (separate cn+global endpoints). */
  region?: "cn" | "global" | "both" | "local";
  /** Historical ids used by other Lumen apps; resolved by getProviderPreset. */
  aliases?: string[];
  /**
   * When set, these body params are merged into chat requests to disable
   * chain-of-thought "thinking" output (from catalog `quirks.no_thinking`).
   * Translation wants fast, terse completions, so thinking is disabled by
   * default; opt out per call via `ProviderEngineOptions.injectNoThinking`.
   */
  noThinking?: {
    bodyParams: Record<string, unknown>;
    /** Case-insensitive substrings; inject only when the model matches. */
    modelFilter?: string[];
  };
}

/**
 * Compose a UI label from the bilingual display name. If the Chinese name
 * already contains the vendor's Latin name (e.g. "MiniMax 大模型"), use it
 * alone; otherwise prefix the English name ("DeepSeek 深度求索").
 */
function toLabel(displayName: { en: string; zh?: string }): string {
  const { en, zh } = displayName;
  if (!zh || zh === en) return en;
  const enFirstWord = en.split(/[\s(（]/)[0]?.toLowerCase() ?? "";
  if (enFirstWord && zh.toLowerCase().includes(enFirstWord)) return zh;
  return `${en} ${zh}`;
}

function toPreset(p: CatalogProvider): ProviderPreset {
  const chatPath = p.chat_path ?? "/chat/completions";
  const primary = p.endpoints?.cn ?? p.endpoints?.global ?? p.endpoints?.local;
  if (!primary) {
    throw new Error(`provider catalog entry "${p.id}" has no usable endpoint`);
  }
  const overseasEndpoint =
    p.endpoints?.cn && p.endpoints?.global
      ? p.endpoints.global.base_url + chatPath
      : undefined;
  const noThinking =
    p.quirks?.no_thinking && p.quirks.no_thinking.strategy === "body_params"
      ? {
          bodyParams: p.quirks.no_thinking.body_params,
          modelFilter: p.quirks.no_thinking.model_filter,
        }
      : undefined;
  return {
    id: p.id,
    label: toLabel(p.display_name),
    endpoint: primary.base_url + chatPath,
    overseasEndpoint,
    model: p.default_model ?? "",
    models: p.models ?? [],
    needsKey: p.needs_key,
    authHeader: p.auth?.header,
    authTemplate: p.auth?.value_template,
    headers: p.extra_headers,
    docs: p.docs_url,
    region: p.region,
    aliases: p.aliases,
    noThinking,
  };
}

/**
 * Which catalog entries become built-in presets here:
 * - must be a chat provider speaking the OpenAI-compatible wire protocol
 *   (excludes `anthropic` — native Messages API — and MT/ASR-only entries);
 * - local engines are excluded: `ollama` has a dedicated engine
 *   (`createOllamaEngine`) and `lm_studio` is covered by the apps' custom
 *   "OpenAI / Compatible" entry;
 * - `openai` is excluded because the apps expose it as the dedicated custom
 *   OpenAI-compatible engine (id "openai" is already taken in their UIs).
 */
function isBuiltinChatProvider(p: CatalogProvider): boolean {
  return (
    p.capabilities.includes("chat") &&
    p.api_style === "openai_compat" &&
    p.region !== "local" &&
    p.id !== "openai"
  );
}

export const PROVIDER_CATALOG: ProviderPreset[] =
  PROVIDER_CATALOG_SOURCE.providers.filter(isBuiltinChatProvider).map(toPreset);

/**
 * Look up a preset by canonical id, falling back to catalog `aliases` so ids
 * saved by older builds (or by sibling Lumen apps, e.g. `zhipu`, `glm-cn`,
 * `volcengine`, `minimax-cn`) keep resolving.
 */
export function getProviderPreset(id: string): ProviderPreset | undefined {
  return (
    PROVIDER_CATALOG.find((p) => p.id === id) ??
    PROVIDER_CATALOG.find((p) => p.aliases?.includes(id))
  );
}

export interface ProviderEngineOptions {
  apiKey?: string;
  /** Override the preset model. */
  model?: string;
  /** For providers with both domestic and overseas endpoints. */
  region?: "cn" | "overseas";
  /** Override endpoint completely (advanced). */
  endpoint?: string;
  temperature?: number;
  systemPrompt?: string;
  /**
   * Override the OpenRouter `HTTP-Referer` attribution header. Ignored for
   * providers that don't use it. Defaults to the repo URL.
   */
  httpReferer?: string;
  /**
   * Override the OpenRouter `X-Title` attribution header. Ignored for
   * providers that don't use it. Defaults to "Lumen Translation".
   */
  xTitle?: string;
  /**
   * Extra headers to merge on top of the preset's headers (caller wins on
   * conflict).
   */
  headers?: Record<string, string>;
  /** Request timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Max retries on 429/503 (default 3). */
  maxRetries?: number;
  /**
   * Inject the provider's `no_thinking` body params (from the catalog quirks)
   * to disable chain-of-thought output on reasoning models. Default true.
   */
  injectNoThinking?: boolean;
}

/**
 * Build an Engine for a built-in provider preset. Returns undefined if the
 * provider id is unknown (after alias resolution).
 */
export function createProviderEngine(
  providerId: string,
  opts: ProviderEngineOptions = {},
): Engine | undefined {
  const preset = getProviderPreset(providerId);
  if (!preset) return undefined;

  const endpoint =
    opts.endpoint ??
    (preset.overseasEndpoint && opts.region === "overseas"
      ? preset.overseasEndpoint
      : preset.endpoint);

  const headers: Record<string, string> = { ...(preset.headers ?? {}) };

  // OpenRouter attribution headers are configurable overrides on top of the
  // preset's neutral defaults. Only apply when the preset already declares
  // them (so we don't add OpenRouter-specific headers to other providers).
  if (preset.headers?.["HTTP-Referer"] && opts.httpReferer !== undefined) {
    headers["HTTP-Referer"] = opts.httpReferer;
  }
  if (preset.headers?.["X-Title"] && opts.xTitle !== undefined) {
    headers["X-Title"] = opts.xTitle;
  }
  // Caller-supplied extra headers always win.
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) headers[k] = v;
  }

  // If the preset declares a custom auth header template, build it from the
  // user's API key and pass it through `headers`. In that case we deliberately
  // do NOT forward the apiKey to createOpenAIEngine, so it won't also emit a
  // default `Authorization: Bearer <key>` that would conflict with the custom
  // header (e.g. `X-API-Key` for some providers).
  let apiKeyForEngine = opts.apiKey;
  if (preset.authTemplate && opts.apiKey) {
    const headerName = preset.authHeader ?? "Authorization";
    headers[headerName] = preset.authTemplate.replace("{key}", opts.apiKey);
    apiKeyForEngine = undefined;
  }

  // Data-driven "disable thinking" injection (catalog `quirks.no_thinking`):
  // reasoning models otherwise stream chain-of-thought tokens, which slows
  // translation down and wastes tokens. A model_filter, when present, limits
  // injection to matching models (e.g. deepseek-reasoner but not
  // deepseek-chat).
  const model = opts.model ?? preset.model;
  let extraBody: Record<string, unknown> | undefined;
  if (opts.injectNoThinking !== false && preset.noThinking) {
    const filter = preset.noThinking.modelFilter;
    const matches =
      !filter ||
      filter.some((f) => model.toLowerCase().includes(f.toLowerCase()));
    if (matches) extraBody = preset.noThinking.bodyParams;
  }

  const openaiOpts: OpenAIEngineOptions = {
    apiKey: apiKeyForEngine,
    endpoint,
    model,
    temperature: opts.temperature,
    systemPrompt: opts.systemPrompt,
    headers,
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
    extraBody,
  };
  const engine = createOpenAIEngine(openaiOpts);
  return { ...engine, id: preset.id, label: preset.label };
}

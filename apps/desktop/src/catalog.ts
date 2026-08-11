/**
 * Provider catalog — the Windows counterpart of
 * `apps/popclip-window/LumenTranslation/ProviderCatalog.swift`.
 *
 * Single source of truth is the vendored `lumen.provider-catalog/v1` file
 * (`packages/engines/src/provider-catalog.v1.json`, refreshed by
 * `tools/sync-provider-catalog.mjs`). It reaches us through
 * `@lumen/engines`' `PROVIDER_CATALOG_SOURCE` export, so provider data
 * (endpoints, models, headers, quirks) is never hardcoded here — only the
 * curated short-list, which is UI policy.
 *
 * We can't reuse `@lumen/engines`' own `PROVIDER_CATALOG` because that view is
 * built for the browser extension: it drops `openai` (the extension exposes it
 * as a separate "custom endpoint" entry) and both free MT engines. This app,
 * like the Swift one, wants all of them.
 */

import { PROVIDER_CATALOG_SOURCE, type CatalogProvider } from '@lumen/engines';

export interface ProviderPreset {
  id: string;
  label: string;
  /** Catalog wire protocol: `openai_compat` | `google_translate` | `microsoft_translator`. */
  apiStyle: string;
  /** Primary endpoint (cn when the provider has one, else global/local). */
  endpointCN: string;
  /** Overseas endpoint, when the provider has separate cn + global endpoints. */
  endpointOverseas?: string;
  defaultModel: string;
  models: string[];
  docsURL?: string;
  needsKey: boolean;
  /** Static headers sent with every request (e.g. OpenRouter attribution). */
  extraHeaders: Record<string, string>;
  /** Historical ids used by older builds / sibling Lumen apps. */
  aliases: string[];
  /** From catalog `quirks.no_thinking` — body params that disable CoT output. */
  noThinkingBodyParams?: Record<string, unknown>;
  noThinkingModelFilter?: string[];
}

/**
 * Curated short-list. Same set and order as `Providers.curatedIds` in
 * `ProviderCatalog.swift`: the two free MT engines, OpenAI, OpenRouter (which
 * is how this app reaches Claude, since it only speaks OpenAI-compatible
 * chat), and four major Chinese providers.
 */
export const CURATED_IDS = [
  'google_translate',
  'microsoft_translator',
  'openai',
  'openrouter',
  'kimi',
  'glm',
  'minimax',
  'deepseek',
];

/**
 * App-local legacy ids beyond the catalog's own `aliases`. "anthropic" was
 * this app's OpenRouter-routed Claude preset, so a key saved under it is an
 * OpenRouter key.
 */
export const LEGACY_ID_MAP: Record<string, string> = { anthropic: 'openrouter' };

/**
 * Wire protocols this app implements. Mirrors `Providers.isSupported`.
 */
function isSupported(p: CatalogProvider): boolean {
  if (p.capabilities.includes('chat')) {
    return p.api_style === 'openai_compat' && p.region !== 'local';
  }
  return (
    p.capabilities.includes('translation') &&
    (p.api_style === 'google_translate' || p.api_style === 'microsoft_translator')
  );
}

/**
 * Compose a UI label from the bilingual display name. Same heuristic as
 * `toLabel` in `packages/engines/src/providers.ts`: if the Chinese name
 * already contains the vendor's Latin name ("MiniMax 大模型"), use it alone;
 * otherwise prefix the English name ("DeepSeek 深度求索").
 */
function toLabel(displayName: { en: string; zh?: string }): string {
  const { en, zh } = displayName;
  if (!zh || zh === en) return en;
  const enFirstWord = en.split(/[\s(（]/)[0]?.toLowerCase() ?? '';
  if (enFirstWord && zh.toLowerCase().includes(enFirstWord)) return zh;
  return `${en} ${zh}`;
}

function toPreset(p: CatalogProvider): ProviderPreset | undefined {
  const primary = p.endpoints?.cn ?? p.endpoints?.global ?? p.endpoints?.local;
  if (!primary) return undefined;
  // `openai_compat` base_url excludes the chat path; MT base_url is already
  // the full endpoint.
  const chatPath = p.api_style === 'openai_compat' ? (p.chat_path ?? '/chat/completions') : '';
  const overseas =
    p.endpoints?.cn && p.endpoints?.global ? p.endpoints.global.base_url + chatPath : undefined;
  const noThinking =
    p.quirks?.no_thinking?.strategy === 'body_params' ? p.quirks.no_thinking : undefined;
  return {
    id: p.id,
    label: toLabel(p.display_name),
    apiStyle: p.api_style,
    endpointCN: primary.base_url + chatPath,
    endpointOverseas: overseas,
    defaultModel: p.default_model ?? '',
    models: p.models ?? [],
    docsURL: p.docs_url,
    needsKey: p.needs_key,
    extraHeaders: p.extra_headers ?? {},
    aliases: p.aliases ?? [],
    noThinkingBodyParams: noThinking?.body_params,
    noThinkingModelFilter: noThinking?.model_filter,
  };
}

/**
 * Last-resort presets if the vendored catalog is missing or corrupt (a build
 * error — it's bundled by Vite). Keeps the free, keyless engines working
 * instead of leaving the user with an empty provider list.
 */
const FALLBACK_CATALOG: ProviderPreset[] = [
  {
    id: 'google_translate',
    label: 'Google 翻译（免费，无需 Key）',
    apiStyle: 'google_translate',
    endpointCN: 'https://translate.googleapis.com/translate_a/single',
    defaultModel: 'gtx',
    models: ['gtx'],
    docsURL: 'https://translate.google.com',
    needsKey: false,
    extraHeaders: {},
    aliases: ['google'],
  },
  {
    id: 'microsoft_translator',
    label: '微软翻译（免费，无需 Key）',
    apiStyle: 'microsoft_translator',
    endpointCN: 'https://api.cognitive.microsofttranslator.com/translate',
    defaultModel: 'free',
    models: ['free'],
    docsURL: 'https://www.bing.com/translator',
    needsKey: false,
    extraHeaders: {},
    aliases: ['microsoft'],
  },
];

/** Build the curated preset list from a catalog file. Injectable for tests. */
export function makeCatalog(
  providers: CatalogProvider[] = PROVIDER_CATALOG_SOURCE.providers,
): ProviderPreset[] {
  if (!Array.isArray(providers)) return FALLBACK_CATALOG;
  const byId = new Map(providers.map((p) => [p.id, p]));
  const presets = CURATED_IDS.flatMap((id) => {
    const p = byId.get(id);
    if (!p || !isSupported(p)) return [];
    const preset = toPreset(p);
    return preset ? [preset] : [];
  });
  return presets.length > 0 ? presets : FALLBACK_CATALOG;
}

export const CATALOG: ProviderPreset[] = makeCatalog();

/**
 * Resolve an id: canonical first, then catalog aliases ("google",
 * "minimax-cn", ...), then app-local legacy ids ("anthropic").
 */
export function findProvider(
  id: string,
  catalog: ProviderPreset[] = CATALOG,
): ProviderPreset | undefined {
  return (
    catalog.find((p) => p.id === id) ??
    catalog.find((p) => p.aliases.includes(id)) ??
    (LEGACY_ID_MAP[id] ? catalog.find((p) => p.id === LEGACY_ID_MAP[id]) : undefined)
  );
}

/**
 * Body params to merge into a chat request to disable "thinking" output,
 * honoring the catalog's case-insensitive `model_filter` substrings. Returns
 * undefined when nothing should be injected for this model.
 */
export function noThinkingInjection(
  preset: ProviderPreset,
  model: string,
): Record<string, unknown> | undefined {
  if (!preset.noThinkingBodyParams) return undefined;
  const filter = preset.noThinkingModelFilter;
  if (filter) {
    const m = model.toLowerCase();
    if (!filter.some((f) => m.includes(f.toLowerCase()))) return undefined;
  }
  return preset.noThinkingBodyParams;
}

import { describe, expect, it } from 'vitest';
import type { CatalogProvider } from '@lumen/engines';
import {
  CATALOG,
  CURATED_IDS,
  findProvider,
  makeCatalog,
  noThinkingInjection,
  type ProviderPreset,
} from '../catalog';

/**
 * These tests pin the behaviour that `ProviderCatalog.swift` has on macOS. The
 * two implementations read the same vendored catalog file, so if one drifts —
 * a legacy id stops resolving, a `no_thinking` filter stops matching — users
 * silently lose a configured provider on one platform only.
 */

function provider(overrides: Partial<CatalogProvider> = {}): CatalogProvider {
  return {
    id: 'openai',
    display_name: { en: 'OpenAI', zh: 'OpenAI' },
    api_style: 'openai_compat',
    region: 'global',
    capabilities: ['chat'],
    endpoints: { global: { base_url: 'https://api.openai.com/v1' } },
    chat_path: '/chat/completions',
    default_model: 'gpt-4.1-mini',
    models: ['gpt-4.1-mini'],
    needs_key: true,
    ...overrides,
  };
}

describe('makeCatalog', () => {
  it('produces the same curated list, in the same order, as the macOS app', () => {
    // Byte-for-byte the assertion in apps/popclip-window/tests/main.swift. If
    // one platform's list changes without the other, this is what catches it.
    // Order is UI policy: the free engines come first, so a user with no API
    // key has something that works at the top of the list.
    expect(CATALOG.map((p) => p.id)).toEqual([
      'google_translate',
      'microsoft_translator',
      'openai',
      'openrouter',
      'kimi',
      'glm',
      'minimax',
      'deepseek',
    ]);
    expect(CATALOG.map((p) => p.id)).toEqual(CURATED_IDS);
  });

  it('resolves the same endpoints the macOS app does', () => {
    // Also mirrored from the Swift smoke test. MiniMax is the interesting one:
    // it is the only curated provider with distinct cn and global endpoints,
    // so it exercises the region split.
    const google = findProvider('google_translate')!;
    expect(google.apiStyle).toBe('google_translate');
    expect(google.endpointCN).toBe('https://translate.googleapis.com/translate_a/single');
    expect(google.needsKey).toBe(false);

    const minimax = findProvider('minimax')!;
    expect(minimax.endpointCN).toBe('https://api.minimaxi.com/v1/chat/completions');
    expect(minimax.endpointOverseas).toBe('https://api.minimax.io/v1/chat/completions');
  });

  it('appends the chat path to openai_compat endpoints but not to MT ones', () => {
    const openai = findProvider('openai')!;
    expect(openai.endpointCN).toMatch(/\/chat\/completions$/);
    const google = findProvider('google_translate')!;
    expect(google.endpointCN).not.toMatch(/\/chat\/completions$/);
  });

  it('exposes an overseas endpoint only when cn and global both exist', () => {
    const withBoth = makeCatalog([
      provider({
        id: 'google_translate',
        api_style: 'google_translate',
        capabilities: ['translation'],
        endpoints: {
          cn: { base_url: 'https://cn.example/t' },
          global: { base_url: 'https://global.example/t' },
        },
      }),
    ]);
    expect(withBoth[0].endpointOverseas).toBe('https://global.example/t');

    const globalOnly = makeCatalog([provider()]);
    expect(globalOnly[0].endpointOverseas).toBeUndefined();
  });

  it("drops providers this app can't drive", () => {
    // Native Anthropic Messages API and local engines are both unsupported:
    // this app only speaks OpenAI-compatible chat and the two MT protocols.
    const filtered = makeCatalog([
      provider({
        id: 'google_translate',
        api_style: 'google_translate',
        capabilities: ['translation'],
        needs_key: false,
        endpoints: { global: { base_url: 'https://translate.example/t' } },
      }),
      provider({ id: 'openai', api_style: 'anthropic' }),
      provider({ id: 'openrouter', region: 'local' }),
    ]);
    expect(filtered.map((p) => p.id)).toEqual(['google_translate']);
  });

  it('falls back to the free engines when the catalog is empty', () => {
    const fallback = makeCatalog([]);
    expect(fallback.map((p) => p.id)).toEqual(['google_translate', 'microsoft_translator']);
    expect(fallback.every((p) => !p.needsKey)).toBe(true);
  });

  it('falls back instead of throwing when the catalog shape is corrupt', () => {
    const fallback = makeCatalog(null as unknown as CatalogProvider[]);
    expect(fallback.map((p) => p.id)).toEqual(['google_translate', 'microsoft_translator']);
  });

  it('composes bilingual labels the same way the engines package does', () => {
    // Chinese name already contains the vendor's Latin name -> use it alone.
    const minimax = makeCatalog([
      provider({ id: 'openai', display_name: { en: 'MiniMax', zh: 'MiniMax 大模型' } }),
    ]);
    expect(minimax[0].label).toBe('MiniMax 大模型');

    // It doesn't -> prefix the English name.
    const deepseek = makeCatalog([
      provider({ id: 'openai', display_name: { en: 'DeepSeek', zh: '深度求索' } }),
    ]);
    expect(deepseek[0].label).toBe('DeepSeek 深度求索');
  });
});

describe('findProvider', () => {
  it('resolves canonical ids', () => {
    expect(findProvider('openai')?.id).toBe('openai');
  });

  it('resolves catalog aliases saved by sibling Lumen apps', () => {
    // "google" is what older builds and the PopClip Config.json still send.
    expect(findProvider('google')?.id).toBe('google_translate');
    expect(findProvider('microsoft')?.id).toBe('microsoft_translator');
  });

  it('maps the app-local anthropic legacy id onto openrouter', () => {
    // The old "Anthropic (Claude)" preset was always OpenRouter-routed, so a
    // key saved under it is an OpenRouter key.
    expect(findProvider('anthropic')?.id).toBe('openrouter');
  });

  it('returns undefined for ids that are not in the curated list', () => {
    expect(findProvider('definitely-not-a-provider')).toBeUndefined();
  });
});

describe('noThinkingInjection', () => {
  const preset = (overrides: Partial<ProviderPreset>): ProviderPreset => ({
    id: 'x',
    label: 'X',
    apiStyle: 'openai_compat',
    endpointCN: 'https://example.com/v1/chat/completions',
    defaultModel: 'm',
    models: ['m'],
    needsKey: true,
    extraHeaders: {},
    aliases: [],
    ...overrides,
  });

  it('returns nothing when the provider declares no quirk', () => {
    expect(noThinkingInjection(preset({}), 'any-model')).toBeUndefined();
  });

  it('injects unconditionally when there is no model filter', () => {
    const p = preset({ noThinkingBodyParams: { enable_thinking: false } });
    expect(noThinkingInjection(p, 'anything')).toEqual({ enable_thinking: false });
  });

  it('honours the model filter case-insensitively', () => {
    // deepseek-reasoner streams chain-of-thought; deepseek-chat does not, and
    // injecting the flag there would be rejected by the API.
    const p = preset({
      noThinkingBodyParams: { thinking: { type: 'disabled' } },
      noThinkingModelFilter: ['reasoner'],
    });
    expect(noThinkingInjection(p, 'DeepSeek-Reasoner')).toEqual({
      thinking: { type: 'disabled' },
    });
    expect(noThinkingInjection(p, 'deepseek-chat')).toBeUndefined();
  });
});

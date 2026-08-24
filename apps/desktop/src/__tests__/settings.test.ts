import { describe, expect, it } from 'vitest';
import { autoDetectRegion } from '../lang';
import {
  activeProvider,
  allProviders,
  apiKeyFor,
  customPreset,
  DEFAULT_SETTINGS,
  effectiveRegion,
  endpointFor,
  findProviderOrCustom,
  modelFor,
  newCustomProvider,
  normalizeChatEndpoint,
  type Settings,
} from '../settings';

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe('normalizeChatEndpoint', () => {
  it('appends the chat path to a base URL', () => {
    expect(normalizeChatEndpoint('https://api.example.com/v1')).toBe(
      'https://api.example.com/v1/chat/completions',
    );
  });

  it('leaves an already-complete chat URL alone', () => {
    const full = 'https://api.example.com/v1/chat/completions';
    expect(normalizeChatEndpoint(full)).toBe(full);
  });

  it('tolerates trailing slashes and surrounding whitespace', () => {
    // Users paste these out of docs; a double slash produces a 404 that reads
    // like an auth failure.
    expect(normalizeChatEndpoint('  https://api.example.com/v1///  ')).toBe(
      'https://api.example.com/v1/chat/completions',
    );
  });

  it('matches the chat path case-insensitively', () => {
    expect(normalizeChatEndpoint('https://x.dev/v1/Chat/Completions')).toBe(
      'https://x.dev/v1/Chat/Completions',
    );
  });

  it('keeps empty and query-bearing complete endpoints intact', () => {
    expect(normalizeChatEndpoint('   ')).toBe('');
    const full = 'https://x.dev/v1/chat/completions?api-version=2026-01-01';
    expect(normalizeChatEndpoint(full)).toBe(full);
  });
});

describe('apiKeyFor', () => {
  it('trims keys on read', () => {
    // A key pasted with a trailing newline would otherwise produce a
    // malformed `Authorization: Bearer <key>\n` header.
    const s = settings({ apiKeys: { openai: '  sk-abc\n' } });
    expect(apiKeyFor(s, 'openai')).toBe('sk-abc');
  });

  it('resolves the key through legacy ids', () => {
    const s = settings({ apiKeys: { openrouter: 'sk-or' } });
    expect(apiKeyFor(s, 'anthropic')).toBe('sk-or');
  });

  it('returns an empty string when nothing is configured', () => {
    expect(apiKeyFor(settings(), 'openai')).toBe('');
  });
});

describe('modelFor', () => {
  it('prefers the saved override', () => {
    const s = settings({ models: { openai: 'gpt-4o' } });
    expect(modelFor(s, 'openai')).toBe('gpt-4o');
  });

  it('falls back to the catalog default', () => {
    expect(modelFor(settings(), 'openai')).toBeTruthy();
  });

  it("reads a custom slot's model", () => {
    const slot = { ...newCustomProvider(), model: 'qwen3' };
    const s = settings({ customProviders: [slot] });
    expect(modelFor(s, slot.id)).toBe('qwen3');
  });
});

describe('custom endpoint slots', () => {
  it('are namespaced so they cannot collide with a catalog id', () => {
    expect(newCustomProvider().id.startsWith('custom:')).toBe(true);
  });

  it('present as OpenAI-compatible presets that always need a key', () => {
    const preset = customPreset({
      id: 'custom:1',
      name: 'Local',
      baseURL: 'http://127.0.0.1:1234/v1',
      model: 'qwen3',
    });
    expect(preset.apiStyle).toBe('openai_compat');
    expect(preset.needsKey).toBe(true);
    expect(preset.endpointCN).toBe('http://127.0.0.1:1234/v1/chat/completions');
  });

  it('fall back to a placeholder label when unnamed', () => {
    const preset = customPreset({ id: 'custom:1', name: '', baseURL: '', model: '' });
    expect(preset.label).toBe('Custom Endpoint');
    expect(preset.endpointCN).toBe('');
  });

  it('appear after the built-in catalog in the provider list', () => {
    const slot = newCustomProvider();
    const list = allProviders(settings({ customProviders: [slot] }));
    expect(list[list.length - 1].id).toBe(slot.id);
    expect(list[0].id).toBe('google_translate');
  });

  it('are resolvable as the active provider', () => {
    const slot = { ...newCustomProvider(), name: 'Local' };
    const s = settings({ customProviders: [slot], providerId: slot.id });
    expect(activeProvider(s).label).toBe('Local');
    expect(findProviderOrCustom(s, slot.id)?.id).toBe(slot.id);
  });
});

describe('activeProvider', () => {
  it('falls back to the first catalog entry for an unknown id', () => {
    // A provider dropped from the curated list must not leave the app with no
    // engine at all.
    const s = settings({ providerId: 'provider-that-was-removed' });
    expect(activeProvider(s).id).toBe('google_translate');
  });
});

describe('region resolution', () => {
  it('detects mainland China from the locale', () => {
    expect(autoDetectRegion('zh-CN', 'UTC')).toBe('cn');
    expect(autoDetectRegion('zh_Hans_CN', 'UTC')).toBe('cn');
    expect(autoDetectRegion('zh-Hant', 'UTC')).toBe('cn');
  });

  it('detects mainland China from the time zone alone', () => {
    expect(autoDetectRegion('en-US', 'Asia/Shanghai')).toBe('cn');
    expect(autoDetectRegion('en-US', 'Asia/Urumqi')).toBe('cn');
  });

  it('treats everything else as overseas', () => {
    expect(autoDetectRegion('en-US', 'America/New_York')).toBe('overseas');
    expect(autoDetectRegion('ja-JP', 'Asia/Tokyo')).toBe('overseas');
    // Hong Kong and Taiwan use the overseas endpoints.
    expect(autoDetectRegion('en-HK', 'Asia/Hong_Kong')).toBe('overseas');
  });

  it('lets an explicit override win over detection', () => {
    expect(effectiveRegion(settings({ region: 'cn' }))).toBe('cn');
    expect(effectiveRegion(settings({ region: 'overseas' }))).toBe('overseas');
  });
});

describe('live subtitle capture scope', () => {
  it('defaults to all system audio so background playback is captured', () => {
    expect(DEFAULT_SETTINGS.liveSubtitleCaptureMode).toBe('allSystemAudio');
  });
});

describe('endpointFor', () => {
  const preset = {
    id: 'minimax',
    label: 'MiniMax',
    apiStyle: 'openai_compat',
    endpointCN: 'https://cn.example/v1/chat/completions',
    endpointOverseas: 'https://global.example/v1/chat/completions',
    defaultModel: 'm',
    models: ['m'],
    needsKey: true,
    extraHeaders: {},
    aliases: [],
  };

  it('uses the overseas endpoint outside mainland China', () => {
    expect(endpointFor(settings({ region: 'overseas' }), preset)).toBe(preset.endpointOverseas);
  });

  it('uses the domestic endpoint inside mainland China', () => {
    expect(endpointFor(settings({ region: 'cn' }), preset)).toBe(preset.endpointCN);
  });

  it('stays on the single endpoint for providers that only have one', () => {
    const single = { ...preset, endpointOverseas: undefined };
    expect(endpointFor(settings({ region: 'overseas' }), single)).toBe(single.endpointCN);
  });
});

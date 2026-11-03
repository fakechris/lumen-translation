import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from '../settings';

/**
 * The fallback chain is the hotkey's latency budget: every engine that wastes
 * time before giving up is time the user spends staring at an empty panel.
 *
 * These tests pin the two rules that make the chain cheap:
 *
 * - a rate-limited engine (HTTP 429 without `Retry-After`) is handed over to
 *   the next provider immediately, not after three backoff rounds, and
 * - an engine whose endpoint is *gone* (HTTP 404 from a keyless endpoint) is
 *   reported as unavailable: it is skipped, it costs no round trip on the
 *   next call, and its raw status never reaches the user-facing error.
 *
 * Google's keyless path also has a browser-API fallback, so a throttled
 * engine costs exactly two requests: the throttled one and the fallback.
 */

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

interface MockOptions {
  google?: () => Response;
  browserApi?: () => Response;
  edge?: () => Response;
  openai?: () => Response;
}

function mockFetch(options: MockOptions) {
  return vi.fn(async (url: string) => {
    const target = String(url);
    if (target.includes('translate-pa.googleapis.com')) {
      return (options.browserApi ?? (() => notFound()))();
    }
    if (target.includes('edge.microsoft.com')) {
      return (options.edge ?? (() => notFound()))();
    }
    if (target.includes('googleapis.com')) {
      return (options.google ?? (() => notFound()))();
    }
    if (target.includes('api.openai.com')) {
      return (options.openai ?? (() => notFound()))();
    }
    return notFound();
  });
}

function notFound(): Response {
  return response(404, {});
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: { get: (name: string) => headers[name] ?? null },
    body: { cancel: () => Promise.resolve() },
  } as unknown as Response;
}

function rateLimited(): Response {
  // Google's free endpoint answers 429 without a Retry-After header.
  return response(429, {});
}

/** Fresh module state for every test: the engine memoization is module-level. */
async function freshTranslate() {
  vi.resetModules();
  return import('../translate');
}

describe('fallback chain cost', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('moves on from a rate-limited engine without retrying it', async () => {
    const { translate } = await freshTranslate();
    const spy = mockFetch({
      google: rateLimited,
      browserApi: rateLimited,
      edge: () => response(404, {}),
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    const startedAt = Date.now();
    await expect(
      translate('hello', settings({ providerId: 'google_translate' })),
    ).rejects.toThrow();
    const elapsed = Date.now() - startedAt;

    // The 429 was answered exactly once: no backoff rounds were spent.
    const googleCalls = spy.mock.calls.filter((c) =>
      String(c[0]).includes('translate.googleapis.com'),
    );
    expect(googleCalls).toHaveLength(1);
    // The browser-API fallback got its single chance, and no more.
    const fallbackCalls = spy.mock.calls.filter((c) =>
      String(c[0]).includes('translate-pa.googleapis.com'),
    );
    expect(fallbackCalls).toHaveLength(1);
    // And the whole chain (including the dead Edge endpoint) stayed
    // well inside the 1.5 s per-engine budget.
    expect(elapsed).toBeLessThan(1500);
  });

  it('keeps a dead endpoint out of the user-facing error', async () => {
    const { translate } = await freshTranslate();
    globalThis.fetch = mockFetch({
      google: rateLimited,
      browserApi: rateLimited,
      edge: () => response(404, {}),
    }) as unknown as typeof fetch;

    const err = await translate('hello', settings({ providerId: 'google_translate' })).catch(
      (e: unknown) => e,
    );

    const message = (err as Error).message;
    // The Edge endpoint's 404 must not be reported to the user...
    expect(message).not.toContain('404');
    expect(message).not.toContain('Edge');
    // ...but the rate limit that actually needs attention is still reported.
    expect(message).toContain('429');
  });

  it('reports a neutral message when every engine is unavailable', async () => {
    const { translate } = await freshTranslate();
    globalThis.fetch = mockFetch({
      google: () => response(404, {}),
      browserApi: () => response(404, {}),
      edge: () => response(404, {}),
    }) as unknown as typeof fetch;

    const err = await translate('hello', settings({ providerId: 'microsoft_translator' })).catch(
      (e: unknown) => e,
    );

    expect((err as Error).message).toBe('no translation service is currently available');
    expect((err as Error).message).not.toContain('404');
  });

  it('still reaches a healthy engine after two failures', async () => {
    const { translate } = await freshTranslate();
    globalThis.fetch = mockFetch({
      google: rateLimited,
      browserApi: rateLimited,
      edge: () => response(404, {}),
      openai: () =>
        response(200, { choices: [{ message: { content: '你好' } }] }),
    }) as unknown as typeof fetch;

    const res = await translate(
      'hello',
      settings({ providerId: 'google_translate', apiKeys: { openai: 'test-key' } }),
    );

    expect(res.translation).toBe('你好');
    expect(res.engine).toBe('OpenAI');
  });

  it('uses the browser API when the keyless path is throttled', async () => {
    const { translate } = await freshTranslate();
    globalThis.fetch = mockFetch({
      google: rateLimited,
      browserApi: () => response(200, [['你好'], ['en']]),
      edge: () => response(404, {}),
    }) as unknown as typeof fetch;

    const res = await translate(
      'hello',
      settings({ providerId: 'google_translate' }),
    );

    expect(res.translation).toBe('你好');
  });
});

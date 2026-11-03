import { describe, it, expect, vi, afterEach } from "vitest";
import {
  EngineFetchError,
  fetchWithRetry,
  isEngineUnavailable,
  RETRY_BUDGET_MS,
} from "../fetch-utils.js";

/**
 * The retry policy is what keeps a hotkey responsive: a rate-limited engine
 * must hand the turn back to the fallback chain fast, not sit in a backoff
 * loop for tens of seconds. These tests pin the two rules that matter:
 *
 * - a 429 without a `Retry-After` header is not retried at all (the server
 *   won't say when to come back, and the next engine answers sooner), and
 * - no engine may spend more than its wall-clock retry budget.
 */

interface MockOptions {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

function mockResponse({ status = 200, headers = {}, body = "{}" }: MockOptions): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "mock",
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
    headers: { get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    body: { cancel: () => Promise.resolve() },
  } as unknown as Response;
}

describe("fetchWithRetry", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("does not retry a 429 that carries no Retry-After header", async () => {
    // The machine is being rate-limited and the server says nothing about
    // when to come back. Retrying would only burn the engine's budget: the
    // next engine in the fallback chain answers right away.
    const spy = vi.fn(async () => mockResponse({ status: 429 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const res = await fetchWithRetry("https://example.test/t", {}, { engineId: "google" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(429);
  });

  it("still retries a 429 that names a Retry-After instant", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(mockResponse({ status: 200, body: '{"ok":true}' }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const res = await fetchWithRetry("https://example.test/t", {}, { engineId: "google" });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it("gives up on a Retry-After that does not fit the retry budget", async () => {
    // The server asks for 30 s; the engine's budget is 1.5 s. Waiting would
    // make the hotkey feel broken, so the response is handed back instead.
    const spy = vi.fn(async () =>
      mockResponse({ status: 429, headers: { "Retry-After": "30" } }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const startedAt = Date.now();
    const res = await fetchWithRetry("https://example.test/t", {}, { engineId: "google" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(429);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("does not retry a 503 when the retry budget is zero", async () => {
    const spy = vi.fn(async () => mockResponse({ status: 503 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    const res = await fetchWithRetry(
      "https://example.test/t",
      {},
      { engineId: "google", retryBudgetMs: 0 },
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(503);
  });

  it("fails a network error immediately when the retry budget is zero", async () => {
    const spy = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    await expect(
      fetchWithRetry(
        "https://example.test/t",
        {},
        { engineId: "google", retryBudgetMs: 0 },
      ),
    ).rejects.toBeInstanceOf(EngineFetchError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("exposes a wall-clock retry budget with a sane default", () => {
    expect(RETRY_BUDGET_MS).toBeGreaterThan(0);
    expect(RETRY_BUDGET_MS).toBeLessThanOrEqual(5000);
  });

  it("caps a retry at the remaining budget instead of the full timeout", async () => {
    // The budget is wall-clock for the whole engine call. A retry that starts
    // inside the budget but runs for the full 30 s timeout would hold the
    // fallback chain hostage long after the budget was spent, so the retry
    // only gets what is left — and times out when that runs out.
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      if (spy.mock.calls.length === 1) {
        // Retryable, and the server says "come back right away".
        return mockResponse({ status: 503, headers: { "Retry-After": "0" } });
      }
      // The retry hangs — only the request's own timeout can end it.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason), {
          once: true,
        });
      });
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    const startedAt = Date.now();
    const err = await fetchWithRetry(
      "https://example.test/t",
      {},
      { engineId: "google", timeoutMs: 30_000, retryBudgetMs: 200, maxRetries: 3 },
    ).catch((e: unknown) => e);

    const elapsed = Date.now() - startedAt;
    expect(err).toBeInstanceOf(EngineFetchError);
    expect((err as InstanceType<typeof EngineFetchError>).kind).toBe("timeout");
    // Not the caller's 30 s timeout: the engine gave up inside its budget.
    expect(elapsed).toBeLessThan(2000);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keeps the first attempt on the caller's full timeout", async () => {
    const spy = vi.fn(async () => mockResponse({ status: 503 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    // A budget smaller than the timeout must not shrink the first attempt:
    // a slow-but-successful engine still gets its full timeout.
    const startedAt = Date.now();
    await fetchWithRetry(
      "https://example.test/t",
      {},
      { engineId: "google", timeoutMs: 30_000, retryBudgetMs: 0 },
    ).catch(() => undefined);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});

describe("isEngineUnavailable", () => {
  it("is true only for the unavailable kind", () => {
    expect(isEngineUnavailable(new EngineFetchError("x", "e", "unavailable"))).toBe(true);
    expect(isEngineUnavailable(new EngineFetchError("x", "e", "http", 404))).toBe(false);
    expect(isEngineUnavailable(new EngineFetchError("x", "e", "network"))).toBe(false);
    expect(isEngineUnavailable(new Error("plain"))).toBe(false);
    expect(isEngineUnavailable(undefined)).toBe(false);
  });
});

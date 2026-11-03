import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The Microsoft Edge auth endpoint answers 404 today. That is a *permanent*
 * condition — the engine cannot work at all until the endpoint comes back — so
 * it must not be reported as a transient HTTP error, and it must not cost a
 * round trip on every translation.
 *
 * The engine memoizes a dead endpoint for ten minutes, so only the first call
 * pays for the probe. The tests below rely on that module-level state, hence
 * the fresh module registry for every test.
 */

function mockResponse(status: number, body = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "mock",
    text: () => Promise.resolve(body),
    json: () => {
      try {
        return Promise.resolve(body ? JSON.parse(body) : {});
      } catch {
        return Promise.resolve({});
      }
    },
    headers: { get: () => null },
    body: { cancel: () => Promise.resolve() },
  } as unknown as Response;
}

const request = {
  pair: { source: "auto", target: "zh-CN" },
  segments: [{ id: "s1", text: "hello" }],
};

/**
 * Fresh module instances for the engine *and* its error classes: the
 * `instanceof` check must run against the very class the engine throws.
 */
async function freshModules() {
  vi.resetModules();
  const microsoft = await import("../microsoft.js");
  const fetchUtils = await import("../fetch-utils.js");
  return { ...microsoft, ...fetchUtils };
}

describe("createMicrosoftEngine with a dead Edge auth endpoint", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    // Fresh module state for every test: the dead-endpoint memo is
    // module-level by design.
    vi.resetModules();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("reports a 404 from the auth endpoint as an unavailable engine", async () => {
    const spy = vi.fn(async () => mockResponse(404));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createMicrosoftEngine, EngineFetchError, isEngineUnavailable } = await freshModules();
    const eng = createMicrosoftEngine();

    const err = await eng.translate(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineFetchError);
    expect((err as InstanceType<typeof EngineFetchError>).kind).toBe("unavailable");
    expect(isEngineUnavailable(err)).toBe(true);
    // The translation endpoint was never reached.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("fails the next call without another round trip", async () => {
    const spy = vi.fn(async () => mockResponse(404));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createMicrosoftEngine, isEngineUnavailable } = await freshModules();
    const eng = createMicrosoftEngine();
    await eng.translate(request).catch(() => undefined);

    const startedAt = Date.now();
    const err = await eng.translate(request).catch((e: unknown) => e);
    const elapsed = Date.now() - startedAt;

    expect(isEngineUnavailable(err)).toBe(true);
    // No second probe: the endpoint's state is already known.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(50);
  });

  it("treats a 410 from the auth endpoint the same way", async () => {
    const spy = vi.fn(async () => mockResponse(410));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createMicrosoftEngine, isEngineUnavailable } = await freshModules();
    const eng = createMicrosoftEngine();

    const err = await eng.translate(request).catch((e: unknown) => e);
    expect(isEngineUnavailable(err)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("warms the endpoint up without throwing when it is gone", async () => {
    const spy = vi.fn(async () => mockResponse(404));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createMicrosoftEngine, warmUpMicrosoftEngine, isEngineUnavailable } =
      await freshModules();
    await expect(warmUpMicrosoftEngine()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);

    // The probe already learned the endpoint is gone, so the first real
    // translation fails without touching the network.
    const eng = createMicrosoftEngine();
    const err = await eng.translate(request).catch((e: unknown) => e);
    expect(isEngineUnavailable(err)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("warmUpMicrosoftEngine", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("caches a live token so the first translation skips the auth call", async () => {
    const spy = vi.fn(async (url: string) =>
      String(url).includes("edge.microsoft.com")
        ? mockResponse(200, "edge-token")
        : mockResponse(200, JSON.stringify([{ translations: [{ text: "你好" }] }])),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createMicrosoftEngine, warmUpMicrosoftEngine } = await freshModules();
    await warmUpMicrosoftEngine();

    const eng = createMicrosoftEngine();
    const res = await eng.translate(request);

    expect(res.segments[0].text).toBe("你好");
    // One auth call (the warm-up) plus one translation call — the
    // translation did not repeat the auth probe.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Edge's translation endpoint no longer needs a token: the auth endpoint was
 * retired upstream (it answers 404), while the translation endpoint itself
 * still serves requests — with a plain array of *strings* as the body.
 *
 * The Azure Cognitive Translator API that the generated provider catalog names
 * cannot serve this engine without a key of its own, so the engine maps it
 * onto Edge's endpoint. These tests pin that mapping and the request shape,
 * because a wrong body shape is answered with HTTP 400 and no explanation.
 */

function mockResponse(status: number, body: unknown = ""): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "mock",
    text: () => Promise.resolve(text),
    json: () => {
      try {
        return Promise.resolve(text ? JSON.parse(text) : {});
      } catch {
        return Promise.resolve({});
      }
    },
    headers: { get: () => null },
    body: { cancel: () => Promise.resolve() },
  } as unknown as Response;
}

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

const request = {
  pair: { source: "auto", target: "zh-CN" },
  segments: [{ id: "s1", text: "hello" }],
};

describe("createMicrosoftEngine request shape", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    // Fresh module state for every test: the dead-endpoint memo is
    // module-level by design.
    vi.resetModules();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("posts to the token-free Edge endpoint with a string array body", async () => {
    const spy = vi.fn(async () =>
      mockResponse(200, [
        { detectedLanguage: { language: "en" }, translations: [{ text: "你好" }] },
      ]),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createMicrosoftEngine } = await freshModules();
    const res = await createMicrosoftEngine().translate(request);

    expect(res.segments[0].text).toBe("你好");
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain(
      "https://edge.microsoft.com/translate/translatetext?",
    );
    expect(String(url)).toContain("to=zh-Hans");
    expect(String(url)).toContain("isEnterpriseClient=false");
    // "auto" is the absence of a `from` parameter, not a literal value.
    expect(String(url)).not.toContain("from=");
    expect(init.method).toBe("POST");
    // The body is an array of strings — `[{ "Text": "..." }]` is rejected
    // upstream with HTTP 400.
    expect(JSON.parse(String(init.body))).toEqual(["hello"]);
  });

  it("maps the Azure endpoint the catalog names onto Edge's endpoint", async () => {
    const spy = vi.fn(async () =>
      mockResponse(200, [{ translations: [{ text: "你好" }] }]),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createMicrosoftEngine } = await freshModules();
    const eng = createMicrosoftEngine({
      endpoint: "https://api.cognitive.microsofttranslator.com/translate",
    });
    await eng.translate(request);

    const [url] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("edge.microsoft.com/translate/translatetext");
    expect(String(url)).not.toContain("cognitive");
    expect(String(url)).not.toContain("api-version");
  });

  it("keeps a custom endpoint as given", async () => {
    const spy = vi.fn(async () =>
      mockResponse(200, [{ translations: [{ text: "你好" }] }]),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createMicrosoftEngine } = await freshModules();
    const eng = createMicrosoftEngine({
      endpoint: "https://proxy.example/translate",
    });
    await eng.translate(request);

    const [url] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("https://proxy.example/translate");
  });

  it("sends the source language when it is known", async () => {
    const spy = vi.fn(async () =>
      mockResponse(200, [{ translations: [{ text: "你好" }] }]),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createMicrosoftEngine } = await freshModules();
    await createMicrosoftEngine().translate({
      pair: { source: "en", target: "zh-TW" },
      segments: [{ id: "s1", text: "hello" }],
    });

    const [url] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("from=en");
    expect(String(url)).toContain("to=zh-Hant");
  });

  it("translates every segment in one request", async () => {
    const spy = vi.fn(async () =>
      mockResponse(200, [
        { translations: [{ text: "第一段" }] },
        { translations: [{ text: "第二段" }] },
      ]),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createMicrosoftEngine } = await freshModules();
    const res = await createMicrosoftEngine().translate({
      pair: { source: "auto", target: "zh-CN" },
      segments: [
        { id: "a", text: "one" },
        { id: "b", text: "two" },
      ],
    });

    expect(res.segments.map((s) => s.text)).toEqual(["第一段", "第二段"]);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual(["one", "two"]);
  });
});

describe("createMicrosoftEngine with a dead Edge endpoint", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("reports a 404 as an unavailable engine", async () => {
    const spy = vi.fn(async () => mockResponse(404));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createMicrosoftEngine, EngineFetchError, isEngineUnavailable } =
      await freshModules();
    const err = await createMicrosoftEngine()
      .translate(request)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EngineFetchError);
    expect((err as InstanceType<typeof EngineFetchError>).kind).toBe("unavailable");
    expect(isEngineUnavailable(err)).toBe(true);
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

  it("does not let a custom endpoint's 404 disable the Edge endpoint", async () => {
    // A 404 from somebody else's proxy says nothing about Edge's endpoint, so
    // it must not disable the engine process-wide.
    const spy = vi.fn(async (url: string) =>
      String(url).includes("proxy.example")
        ? mockResponse(404)
        : mockResponse(200, [{ translations: [{ text: "你好" }] }]),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createMicrosoftEngine, isEngineUnavailable } = await freshModules();
    const custom = createMicrosoftEngine({ endpoint: "https://proxy.example/translate" });
    const err = await custom.translate(request).catch((e: unknown) => e);
    expect(isEngineUnavailable(err)).toBe(true);

    // The Edge endpoint still answers.
    const edge = createMicrosoftEngine();
    const res = await edge.translate(request);
    expect(res.segments[0].text).toBe("你好");
  });

  it("treats a 410 the same way", async () => {
    const spy = vi.fn(async () => mockResponse(410));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createMicrosoftEngine, isEngineUnavailable } = await freshModules();
    const err = await createMicrosoftEngine()
      .translate(request)
      .catch((e: unknown) => e);

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

  it("sends one probe request so the first translation does not pay for it", async () => {
    const spy = vi.fn(async (_url: string, init?: RequestInit) =>
      // The probe translates "a"; the real request translates "hello".
      String(init?.body) === '["a"]'
        ? mockResponse(200, [{ translations: [{ text: "a" }] }])
        : mockResponse(200, [{ translations: [{ text: "你好" }] }]),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createMicrosoftEngine, warmUpMicrosoftEngine } = await freshModules();
    await warmUpMicrosoftEngine();

    const eng = createMicrosoftEngine();
    const res = await eng.translate(request);

    expect(res.segments[0].text).toBe("你好");
    // One probe plus one translation — the translation did not repeat the
    // probe.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

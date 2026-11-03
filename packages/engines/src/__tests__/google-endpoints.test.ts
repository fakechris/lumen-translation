import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

/**
 * The free Google endpoint moved: the keyless path is now
 * `POST https://translate.googleapis.com/translate_a/t` with a form body, and
 * `GET /translate_a/single` is what the generated provider catalog still
 * names.
 *
 * These tests pin the *request shape* — method, URL, body, headers — because
 * that is what silently breaks when an endpoint changes: the response is still
 * JSON, so a wrong request only shows up as an empty translation.
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
 * Fresh module instances for every test: the engine remembers that the
 * browser-API fallback answered, and that state is module-level by design.
 */
async function freshGoogle() {
  vi.resetModules();
  const google = await import("../google.js");
  const fetchUtils = await import("../fetch-utils.js");
  return { ...google, ...fetchUtils };
}

const request = {
  pair: { source: "auto", target: "zh-CN" },
  segments: [{ id: "s1", text: "hello" }],
};

describe("createGoogleEngine request shape", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("posts to /translate_a/t with the text in a form body", async () => {
    const spy = vi.fn(async () => mockResponse(200, [["你好", "en"]]));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createGoogleEngine } = await freshGoogle();
    const eng = createGoogleEngine();
    const res = await eng.translate(request);

    expect(res.segments[0].text).toBe("你好");
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("https://translate.googleapis.com/translate_a/t?");
    expect(String(url)).toContain("sl=auto");
    expect(String(url)).toContain("tl=zh-CN");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(String(init.body)).toBe("q=hello");
  });

  it("rewrites the legacy catalog endpoint onto the current path", async () => {
    const spy = vi.fn(async () => mockResponse(200, [["你好", "en"]]));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createGoogleEngine } = await freshGoogle();
    // This is exactly what the desktop app hands over: the vendored catalog's
    // `base_url` plus the client's query string.
    const eng = createGoogleEngine({
      endpoint: "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t",
    });
    await eng.translate(request);

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/translate_a/t?");
    expect(String(url)).not.toContain("/translate_a/single");
    expect(String(url)).toContain("client=gtx");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toBe("q=hello");
  });

  it("keeps a custom endpoint on the legacy GET contract", async () => {
    const spy = vi.fn(async () =>
      mockResponse(200, [[["你好", "hello", null, null, 1]], null, "en"]),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createGoogleEngine } = await freshGoogle();
    const eng = createGoogleEngine({
      endpoint: "https://proxy.example/translate_a/single?client=gtx&dt=t",
    });
    const res = await eng.translate(request);

    expect(res.segments[0].text).toBe("你好");
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(String(url)).toContain("q=hello");
  });

  it("does not forward a custom endpoint's text to Google's browser API", async () => {
    // The caller pointed the engine at their own proxy. If the primary request
    // fails, the text must not silently leave for Google instead.
    const spy = vi.fn(async (_url: string) => mockResponse(429));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createGoogleEngine } = await freshGoogle();
    const eng = createGoogleEngine({
      endpoint: "https://proxy.example/translate_a/single?client=gtx&dt=t",
    });
    await eng.translate(request).catch(() => undefined);

    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("translate-pa.googleapis.com"))).toBe(false);
    expect(urls.every((u) => u.includes("proxy.example"))).toBe(true);
  });

  it("splits a custom GET endpoint's batches so the URL stays short", async () => {
    // The legacy GET contract carries the text in the query string, where
    // browsers and proxies enforce a much shorter limit than a request body.
    const SEP = "\n\n@@@\n\n";
    const spy = vi.fn(async (url: string) => {
      const q = new URL(String(url)).searchParams.get("q") ?? "";
      const translated = q
        .split(SEP)
        .map((part) => `译:${part}`)
        .join(SEP);
      return mockResponse(200, [[[translated, q, null, null, 1]], null, "en"]);
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createGoogleEngine } = await freshGoogle();
    const eng = createGoogleEngine({
      endpoint: "https://proxy.example/translate_a/single?client=gtx&dt=t",
    });
    const long = "x".repeat(1200);
    const res = await eng.translate({
      pair: { source: "auto", target: "zh-CN" },
      segments: [
        { id: "a", text: long },
        { id: "b", text: long },
        { id: "c", text: long },
      ],
    });

    expect(spy.mock.calls.length).toBeGreaterThan(1);
    for (const call of spy.mock.calls) {
      expect(String(call[0]).length).toBeLessThanOrEqual(2000);
    }
    expect(res.segments.map((s) => s.text)).toEqual([
      `译:${long}`,
      `译:${long}`,
      `译:${long}`,
    ]);
  });
});

describe("createGoogleEngine response shapes", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("parses the flat response of the current endpoint", async () => {
    const spy = vi.fn(async () => mockResponse(200, [["你好世界", "en"]]));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createGoogleEngine } = await freshGoogle();
    const res = await createGoogleEngine().translate({
      pair: { source: "auto", target: "zh-CN" },
      segments: [{ id: "s1", text: "Hello World" }],
    });
    expect(res.segments[0].text).toBe("你好世界");
  });

  it("still parses the nested response of the legacy endpoint", async () => {
    const spy = vi.fn(async () =>
      mockResponse(200, [[["你好", "Hello", null, null, 1]], null, "en"]),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createGoogleEngine } = await freshGoogle();
    const res = await createGoogleEngine().translate(request);
    expect(res.segments[0].text).toBe("你好");
  });
});

describe("createGoogleEngine browser-API fallback", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("falls back to the browser API when the keyless path is throttled", async () => {
    const spy = vi.fn(async (url: string) =>
      String(url).includes("translate-pa.googleapis.com")
        ? mockResponse(200, [["你好"], ["en"]])
        : mockResponse(429, "slow down"),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createGoogleEngine } = await freshGoogle();
    const res = await createGoogleEngine().translate(request);

    expect(res.segments[0].text).toBe("你好");
    expect(spy).toHaveBeenCalledTimes(2);
    const [fallbackUrl, fallbackInit] = spy.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    expect(String(fallbackUrl)).toBe(
      "https://translate-pa.googleapis.com/v1/translateHtml",
    );
    expect(fallbackInit.method).toBe("POST");
    const headers = fallbackInit.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBeTruthy();
    expect(headers["Content-Type"]).toBe("application/json+protobuf");
    expect(JSON.parse(String(fallbackInit.body))).toEqual([
      [["hello"], "auto", "zh-CN"],
      "te_lib",
    ]);
  });

  it("maps the browser API's per-text results back to the segments", async () => {
    const spy = vi.fn(async (url: string) =>
      String(url).includes("translate-pa.googleapis.com")
        ? mockResponse(200, [["第一段", "第二段"], ["en", "en"]])
        : mockResponse(429),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createGoogleEngine } = await freshGoogle();
    const res = await createGoogleEngine().translate({
      pair: { source: "auto", target: "zh-CN" },
      segments: [
        { id: "a", text: "one" },
        { id: "b", text: "two" },
      ],
    });

    expect(res.segments.map((s) => s.text)).toEqual(["第一段", "第二段"]);
    const [, fallbackInit] = spy.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(fallbackInit.body))).toEqual([
      [["one", "two"], "auto", "zh-CN"],
      "te_lib",
    ]);
  });

  it("reports the engine as unavailable when both paths are gone", async () => {
    const spy = vi.fn(async () => mockResponse(404));
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createGoogleEngine, EngineFetchError, isEngineUnavailable } =
      await freshGoogle();
    const err = await createGoogleEngine()
      .translate(request)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(EngineFetchError);
    expect((err as InstanceType<typeof EngineFetchError>).kind).toBe("unavailable");
    expect(isEngineUnavailable(err)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("uses the browser API directly once it has answered", async () => {
    const spy = vi.fn(async (url: string) =>
      String(url).includes("translate-pa.googleapis.com")
        ? mockResponse(200, [["你好"], ["en"]])
        : mockResponse(429),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const { createGoogleEngine } = await freshGoogle();
    const eng = createGoogleEngine();
    await eng.translate(request);
    await eng.translate(request);

    // The second translation must not pay for the doomed keyless request.
    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes("translate-pa.googleapis.com"))).toHaveLength(2);
    expect(urls.filter((u) => u.includes("translate.googleapis.com"))).toHaveLength(1);
  });
});

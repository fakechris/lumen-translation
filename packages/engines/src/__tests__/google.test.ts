import { describe, it, expect, vi, afterEach } from "vitest";
import { createGoogleEngine } from "../google.js";
import { TranslationError } from "@lumen/core";

/**
 * Google Translate free endpoint (`translate_a/single?client=gtx&dt=t`)
 * returns a nested array, not an object with a `.data` field:
 *   [[["translated","original",null,null,3], ...], null, "srcLang", ...]
 * These tests pin that parsing so a regression (e.g. reading `json.data`)
 * is caught without needing the live endpoint.
 */

function mockResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
    headers: { get: () => null },
  } as unknown as Response;
}

describe("createGoogleEngine", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("parses the nested-array response and returns the translation", async () => {
    const spy = vi.fn(async () =>
      mockResponse([[["敏捷的棕色狐狸", "The quick brown fox", null, null, 3]], null, "en"]),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const eng = createGoogleEngine();
    const r = await eng.translate({
      pair: { source: "auto", target: "zh-CN" },
      segments: [{ id: "s1", text: "The quick brown fox" }],
    });
    expect(r.segments[0].text).toBe("敏捷的棕色狐狸");
  });

  it("concatenates multiple sentence tuples into one segment", async () => {
    const spy = vi.fn(async () =>
      mockResponse([
        [["你好", "Hello", null, null, 1], ["世界", "World", null, null, 1]],
        null,
        "en",
      ]),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const eng = createGoogleEngine();
    const r = await eng.translate({
      pair: { source: "auto", target: "zh-CN" },
      segments: [{ id: "s1", text: "Hello World" }],
    });
    expect(r.segments[0].text).toBe("你好世界");
  });

  it("splits multi-segment input on the @@@ separator", async () => {
    // Engine joins segments with "\n\n@@@\n\n"; the response's translated text
    // is expected to contain the same separator to map back per segment.
    const spy = vi.fn(async () =>
      mockResponse([
        [["第一段\n\n@@@\n\n第二段", "one\n\n@@@\n\ntwo", null, null, 1]],
        null,
        "en",
      ]),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const eng = createGoogleEngine();
    const r = await eng.translate({
      pair: { source: "auto", target: "zh-CN" },
      segments: [
        { id: "a", text: "one" },
        { id: "b", text: "two" },
      ],
    });
    expect(r.segments[0].text).toBe("第一段");
    expect(r.segments[1].text).toBe("第二段");
  });

  it("throws on empty translation for non-empty input", async () => {
    const spy = vi.fn(async () => mockResponse([[], null, "en"]));
    globalThis.fetch = spy as unknown as typeof fetch;

    const eng = createGoogleEngine();
    await expect(
      eng.translate({
        pair: { source: "auto", target: "zh-CN" },
        segments: [{ id: "s1", text: "something" }],
      }),
    ).rejects.toThrow(TranslationError);
  });

  it("passes through empty/whitespace input without calling the endpoint", async () => {
    const spy = vi.fn(async () => mockResponse([[], null, "en"]));
    globalThis.fetch = spy as unknown as typeof fetch;

    const eng = createGoogleEngine();
    const r = await eng.translate({
      pair: { source: "auto", target: "zh-CN" },
      segments: [{ id: "s1", text: "   " }],
    });
    expect(r.segments[0].text).toBe("   ");
    expect(spy).not.toHaveBeenCalled();
  });
});

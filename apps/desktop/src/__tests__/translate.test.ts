import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, newCustomProvider, type Settings } from "../settings";
import {
  contextAwareUserContent,
  fallbackChain,
  TranslationFlightController,
} from "../translate";

/**
 * The fallback chain is what stops a rate-limited Google endpoint from looking
 * like a broken app: it is the behaviour `LLMService.swift` added on macOS, and
 * these tests pin the same ordering here.
 */

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

const ids = (s: Settings) => fallbackChain(s).map((p) => p.id);

describe("contextAwareUserContent", () => {
  it("returns text verbatim when no context is provided", () => {
    expect(contextAwareUserContent("hello world", undefined)).toBe("hello world");
    expect(
      contextAwareUserContent("hello world", { previousSource: "", previousTranslation: "" }),
    ).toBe("hello world");
  });

  it("includes previous source and translation context cleanly", () => {
    const formatted = contextAwareUserContent("Now let's examine the data.", {
      previousSource: "We are studying neural networks.",
      previousTranslation: "我们正在研究神经网络。",
    });
    expect(formatted).toContain("Previous source context: We are studying neural networks.");
    expect(formatted).toContain("Previous translation context: 我们正在研究神经网络。");
    expect(formatted).toContain("--- Text to translate ---\nNow let's examine the data.");
  });
});

describe("TranslationFlightController", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("cancels previous in-flight draft when new draft arrives", async () => {
    globalThis.fetch = vi.fn(async (_url, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 30);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
      return {
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify([[["测试", "test", null, null, 1]], null, "en"]),
          ),
        json: () =>
          Promise.resolve([[["测试", "test", null, null, 1]], null, "en"]),
        headers: { get: () => null },
      } as unknown as Response;
    });

    const controller = new TranslationFlightController();
    const results: string[] = [];

    const p1 = controller.requestDraft(
      1,
      "first draft",
      settings({ providerId: "google_translate" }),
      (res) => results.push(res.translation),
    );
    const p2 = controller.requestDraft(
      1,
      "second draft",
      settings({ providerId: "google_translate" }),
      (res) => results.push(res.translation),
    );

    await Promise.allSettled([p1, p2]);
    expect(results).toEqual(["测试"]);
  });

  it("handles final translation flight requests and slot cancellation", async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify([[["最终结果", "final", null, null, 1]], null, "en"]),
          ),
        json: () =>
          Promise.resolve([[["最终结果", "final", null, null, 1]], null, "en"]),
        headers: { get: () => null },
      } as unknown as Response;
    });

    const controller = new TranslationFlightController();
    const results: string[] = [];

    await controller.requestFinal(
      "utterance-1",
      "final text",
      settings({ providerId: "google_translate" }),
      (res) => results.push(res.translation),
    );

    expect(results).toEqual(["最终结果"]);
  });
});

describe("fallbackChain", () => {
  it("puts the user's selection first", () => {
    const s = settings({ providerId: "microsoft_translator" });
    expect(ids(s)[0]).toBe("microsoft_translator");
  });

  it("always backs the selection with the two keyless MT engines", () => {
    const chain = ids(settings({ providerId: "google_translate" }));
    expect(chain).toContain("microsoft_translator");
    expect(chain).toContain("google_translate");
  });

  it("never repeats a provider", () => {
    // The selection is also one of the free engines here.
    const chain = ids(settings({ providerId: "google_translate" }));
    expect(new Set(chain).size).toBe(chain.length);
  });

  it("skips key-requiring providers that have no key", () => {
    // Out of the box only the free engines are reachable; offering OpenAI
    // would just add a guaranteed 401 to every fallback.
    expect(ids(settings())).toEqual(["google_translate", "microsoft_translator"]);
  });

  it("appends configured LLMs after the free engines", () => {
    const s = settings({ apiKeys: { deepseek: "sk-test" } });
    const chain = ids(s);
    expect(chain).toEqual([
      "google_translate",
      "microsoft_translator",
      "deepseek",
    ]);
  });

  it("keeps a selected LLM first while still falling back to free engines", () => {
    const s = settings({
      providerId: "openai",
      apiKeys: { openai: "sk-test" },
    });
    expect(ids(s)).toEqual([
      "openai",
      "microsoft_translator",
      "google_translate",
    ]);
  });

  it("drops the selected provider entirely when its key is missing", () => {
    // Selecting OpenAI without a key must not strand the user: the free
    // engines still answer.
    const chain = ids(settings({ providerId: "openai" }));
    expect(chain[0]).toBe("microsoft_translator");
    expect(chain).not.toContain("openai");
  });

  it("includes custom endpoint slots that have a key", () => {
    const slot = {
      ...newCustomProvider(),
      name: "Local",
      baseURL: "http://127.0.0.1:1234/v1",
      model: "qwen3",
    };
    const s = settings({
      customProviders: [slot],
      apiKeys: { [slot.id]: "sk-local" },
    });
    expect(ids(s)).toContain(slot.id);
  });

  it("excludes custom endpoint slots with no key", () => {
    const slot = newCustomProvider();
    expect(ids(settings({ customProviders: [slot] }))).not.toContain(slot.id);
  });

  it("resolves a legacy selection through the alias map", () => {
    // A settings file written by an older build can still say "anthropic".
    const s = settings({
      providerId: "anthropic",
      apiKeys: { openrouter: "sk-or" },
    });
    expect(ids(s)[0]).toBe("openrouter");
  });
});


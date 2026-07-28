import { describe, it, expect, vi } from "vitest";
import {
  PROVIDER_CATALOG,
  PROVIDER_CATALOG_SOURCE,
  getProviderPreset,
  createProviderEngine,
} from "../providers.js";

/**
 * Contract-conformance tests for the vendored lumen-suite provider catalog
 * (`packages/engines/src/provider-catalog.v1.json`) and the adapter that
 * derives `PROVIDER_CATALOG` from it.
 */

/** Provider ids that older builds of this repo persisted in user settings. */
const LEGACY_TRANSLATION_IDS = [
  "deepseek",
  "glm",
  "kimi",
  "minimax",
  "doubao",
  "qwen",
  "hunyuan",
  "ernie",
  "spark",
  "baichuan",
  "yi",
  "siliconflow",
  "openrouter",
];

describe("vendored provider catalog (lumen.provider-catalog/v1)", () => {
  it("declares the v1 spec and a semver version", () => {
    expect(PROVIDER_CATALOG_SOURCE.spec).toBe("lumen.provider-catalog/v1");
    expect(PROVIDER_CATALOG_SOURCE.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PROVIDER_CATALOG_SOURCE.providers.length).toBeGreaterThan(0);
  });

  it("has unique, well-formed provider ids", () => {
    const ids = PROVIDER_CATALOG_SOURCE.providers.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9_]+$/);
  });

  it("aliases never collide with another provider's id or aliases", () => {
    const seen = new Map<string, string>();
    for (const p of PROVIDER_CATALOG_SOURCE.providers) {
      for (const name of [p.id, ...(p.aliases ?? [])]) {
        const owner = seen.get(name);
        expect(
          owner === undefined || owner === p.id,
          `"${name}" claimed by both "${owner}" and "${p.id}"`,
        ).toBe(true);
        seen.set(name, p.id);
      }
    }
  });

  it("every networked chat provider has an endpoint, default model and auth info", () => {
    const chat = PROVIDER_CATALOG_SOURCE.providers.filter(
      (p) =>
        p.capabilities.includes("chat") &&
        ["openai_compat", "anthropic", "ollama"].includes(p.api_style),
    );
    expect(chat.length).toBeGreaterThan(0);
    for (const p of chat) {
      const endpoints = Object.values(p.endpoints ?? {});
      expect(endpoints.length, `${p.id} has no endpoints`).toBeGreaterThan(0);
      for (const ep of endpoints) {
        expect(ep.base_url, `${p.id} endpoint`).toMatch(/^https?:\/\//);
        // Contract: base_url never embeds the chat path (chat_path is appended).
        expect(ep.base_url, `${p.id} base_url must not contain chat path`).not.toMatch(
          /\/chat\/completions|chatcompletion/,
        );
      }
      expect(p.default_model, `${p.id} default_model`).toBeTruthy();
      expect(typeof p.needs_key, `${p.id} needs_key`).toBe("boolean");
      if (p.auth) {
        expect(p.auth.header).toBeTruthy();
        expect(p.auth.value_template).toContain("{key}");
      }
    }
  });
});

describe("PROVIDER_CATALOG adapter", () => {
  it("exposes only OpenAI-compatible remote chat providers", () => {
    for (const p of PROVIDER_CATALOG) {
      expect(p.endpoint).toMatch(/^https:\/\//);
      expect(p.model).toBeTruthy();
      // ollama/lm_studio/openai/anthropic are handled elsewhere in the apps.
      expect(["ollama", "lm_studio", "openai", "anthropic"]).not.toContain(p.id);
    }
  });

  it("keeps every preset's default model in its models list", () => {
    for (const p of PROVIDER_CATALOG) {
      if (p.models.length > 0) {
        expect(p.models, `${p.id} default model in models[]`).toContain(p.model);
      }
    }
  });

  it("resolves every legacy translation provider id", () => {
    for (const id of LEGACY_TRANSLATION_IDS) {
      const preset = getProviderPreset(id);
      expect(preset, `legacy id "${id}" must resolve`).toBeDefined();
      // All legacy translation ids are canonical catalog ids.
      expect(preset!.id).toBe(id);
    }
  });

  it("resolves sibling-app aliases to canonical presets", () => {
    const cases: Array<[alias: string, canonical: string]> = [
      ["zhipu", "glm"],
      ["glm-cn", "glm"],
      ["glm-global", "glm"],
      ["volcengine", "doubao"],
      ["minimax-cn", "minimax"],
      ["minimax-global", "minimax"],
      ["aliyun_qwen", "qwen"],
    ];
    for (const [alias, canonical] of cases) {
      expect(getProviderPreset(alias)?.id, `${alias} -> ${canonical}`).toBe(canonical);
    }
  });

  it("uses the current MiniMax endpoints and default model (not the legacy chatcompletion_v2)", () => {
    const minimax = getProviderPreset("minimax")!;
    expect(minimax.endpoint).toBe("https://api.minimaxi.com/v1/chat/completions");
    expect(minimax.overseasEndpoint).toBe("https://api.minimax.io/v1/chat/completions");
    expect(minimax.model).toBe("MiniMax-M3");
    expect(minimax.endpoint).not.toContain("chatcompletion_v2");
    expect(minimax.overseasEndpoint).not.toContain("api.minimax.chat");
  });

  it("picks up the updated Kimi default model and GLM overseas endpoint", () => {
    expect(getProviderPreset("kimi")!.model).toBe("kimi-latest");
    const glm = getProviderPreset("glm")!;
    expect(glm.endpoint).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(glm.overseasEndpoint).toBe("https://api.z.ai/api/paas/v4/chat/completions");
  });

  it("keeps OpenRouter attribution headers from the catalog", () => {
    const openrouter = getProviderPreset("openrouter")!;
    expect(openrouter.headers?.["HTTP-Referer"]).toBeTruthy();
    expect(openrouter.headers?.["X-Title"]).toBeTruthy();
  });
});

describe("no_thinking quirk injection", () => {
  function mockChatFetch() {
    return vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "translated" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
  }

  async function requestBodyFor(
    providerId: string,
    opts: Parameters<typeof createProviderEngine>[1] = {},
  ): Promise<Record<string, unknown>> {
    const fetchMock = mockChatFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const engine = createProviderEngine(providerId, { apiKey: "k", ...opts });
      expect(engine).toBeDefined();
      await engine!.translate({
        pair: { source: "en", target: "zh" },
        segments: [{ id: "1", text: "hello" }],
      });
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      return JSON.parse(String(init.body));
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("injects thinking-disabled params for MiniMax (no model filter)", async () => {
    const body = await requestBodyFor("minimax");
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_split).toBe(true);
    // Core request fields must survive the merge.
    expect(body.model).toBe("MiniMax-M3");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.stream).toBe(false);
  });

  it("injects enable_thinking:false for Qwen", async () => {
    const body = await requestBodyFor("qwen");
    expect(body.enable_thinking).toBe(false);
    expect(body.think).toBe(false);
  });

  it("respects DeepSeek's model_filter: chat model untouched, reasoner injected", async () => {
    const chatBody = await requestBodyFor("deepseek");
    expect(chatBody.thinking).toBeUndefined();

    const reasonerBody = await requestBodyFor("deepseek", { model: "deepseek-reasoner" });
    expect(reasonerBody.thinking).toEqual({ type: "disabled" });
  });

  it("injects reasoning-off params for OpenRouter", async () => {
    const body = await requestBodyFor("openrouter");
    expect(body.reasoning).toEqual({ effort: "none", exclude: true });
  });

  it("can be opted out per call", async () => {
    const body = await requestBodyFor("minimax", { injectNoThinking: false });
    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_split).toBeUndefined();
  });

  it("does not inject anything for providers without the quirk", async () => {
    const body = await requestBodyFor("kimi");
    expect(body.thinking).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
  });

  it("builds an engine with the canonical id when called with an alias", async () => {
    const fetchMock = mockChatFetch();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const engine = createProviderEngine("zhipu", { apiKey: "k" });
      expect(engine).toBeDefined();
      expect(engine!.id).toBe("glm");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

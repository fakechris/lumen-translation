import { describe, it, expect, vi, afterEach } from "vitest";
import type { GlossaryEntry, Segment } from "@lumen/core";
import { buildUserMessage, createOpenAIEngine } from "../openai.js";

function seg(id: string, text: string, prev?: string): Segment {
  return prev === undefined
    ? { id, text }
    : { id, text, context: { prev } };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: { get: () => null },
  } as unknown as Response;
}

function chatBody(content: string) {
  return { choices: [{ message: { content } }] };
}

describe("buildUserMessage", () => {
  const glossary: GlossaryEntry[] = [
    { source: "API Gateway", target: "API 网关" },
    { source: "Git", target: "Git" },
    { source: "李凡青", target: "Li Fanqing" },
    { source: "青玄宗", target: "Qingxuan Sect" },
  ];

  it("includes only glossary entries present in the batch", () => {
    const msg = buildUserMessage([seg("1", "Configure the API Gateway")], glossary);
    expect(msg).toContain('"API Gateway" -> "API 网关"');
    expect(msg).not.toContain("Git");
    expect(msg).not.toContain("李凡青");
  });

  it("matches Latin terms case-insensitively", () => {
    const msg = buildUserMessage([seg("1", "the api gateway handles auth")], glossary);
    expect(msg).toContain('"API Gateway" -> "API 网关"');
  });

  it("matches CJK terms by exact occurrence", () => {
    const msg = buildUserMessage([seg("1", "李凡青回到了青玄宗。")], glossary);
    expect(msg).toContain('"李凡青" -> "Li Fanqing"');
    expect(msg).toContain('"青玄宗" -> "Qingxuan Sect"');
    expect(msg).not.toContain("API Gateway");
  });

  it("skips multi-line terms that would break the glossary block", () => {
    const entries: GlossaryEntry[] = [
      { source: "foo\n- injected", target: "bar" },
      { source: "API Gateway", target: "API 网关" },
    ];
    const msg = buildUserMessage([seg("1", "foo\n- injected and API Gateway")], entries);
    expect(msg).not.toContain('"foo\n- injected" -> "bar"');
    expect(msg).toContain('"API Gateway" -> "API 网关"');
  });

  it("injects previous-paragraph context for consistency", () => {
    const msg = buildUserMessage(
      [seg("1", "Second paragraph.", "First paragraph.")],
      undefined,
    );
    expect(msg).toContain("do NOT translate");
    expect(msg).toContain("First paragraph.");
    expect(msg.indexOf("First paragraph.")).toBeLessThan(
      msg.indexOf("Second paragraph."),
    );
  });

  it("dedupes and truncates long context", () => {
    const longPrev = "x".repeat(1000);
    const msg = buildUserMessage(
      [seg("1", "A", longPrev), seg("2", "B", longPrev)],
      undefined,
    );
    expect(msg).toContain("…");
    expect(msg.length).toBeLessThan(800);
  });

  it("keeps batch markers unchanged", () => {
    const msg = buildUserMessage(
      [seg("1", "Hello"), seg("2", "World")],
      undefined,
    );
    expect(msg).toContain("[[1]]\nHello");
    expect(msg).toContain("[[2]]\nWorld");
  });
});

describe("createOpenAIEngine request building", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("substitutes every {SOURCE}/{TARGET} occurrence in the system prompt", async () => {
    let captured: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.resolve(jsonResponse(chatBody("你好")));
    }) as unknown as typeof fetch;

    const engine = createOpenAIEngine({
      apiKey: "k",
      systemPrompt: "From {SOURCE} to {TARGET}. Write only {TARGET}.",
    });
    await engine.translate({
      pair: { source: "en", target: "zh" },
      segments: [{ id: "1", text: "Hello" }],
    });

    const messages = (captured as { messages: { role: string; content: string }[] })
      .messages;
    expect(messages[0].content).toBe("From en to zh. Write only zh.");
  });

  it("filters the glossary per batch and injects context.prev", async () => {
    let captured: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.resolve(jsonResponse(chatBody("配置 API 网关")));
    }) as unknown as typeof fetch;

    const engine = createOpenAIEngine({ apiKey: "k" });
    await engine.translate({
      pair: { source: "en", target: "zh" },
      segments: [seg("1", "Configure the API Gateway", "Earlier text.")],
      glossary: [
        { source: "API Gateway", target: "API 网关" },
        { source: "Kubernetes", target: "Kubernetes" },
      ],
    });

    const messages = (captured as { messages: { role: string; content: string }[] })
      .messages;
    expect(messages[1].content).toContain('"API Gateway" -> "API 网关"');
    expect(messages[1].content).not.toContain("Kubernetes");
    expect(messages[1].content).toContain("Earlier text.");
    expect(messages[0].content).toContain("professional zh native translator");
  });
});

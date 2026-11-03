import { describe, it, expect, vi, afterEach } from "vitest";
import { createOpenAIEngine } from "../openai.js";

/**
 * A reasoning model that ignores the provider's "disable thinking" flag still
 * streams its scratchpad inside `<think>…</think>`. The engine must remove it
 * before the text reaches the translation pane — in both the buffered and the
 * streaming path.
 */

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

function sseResponse(chunks: string[]): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve({}),
    headers: { get: () => null },
    body: streamFromChunks(chunks),
  } as unknown as Response;
}

function jsonResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
    headers: { get: () => null },
  } as unknown as Response;
}

const request = {
  pair: { source: "auto", target: "zh-CN" },
  segments: [{ id: "s1", text: "hello" }],
};

describe("createOpenAIEngine reasoning scrubbing", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("strips the reasoning block from a buffered answer", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse("<think>The user wants Chinese.</think>你好"),
    ) as unknown as typeof fetch;

    const eng = createOpenAIEngine({ stripThinkingTags: true });
    const res = await eng.translate(request);

    expect(res.segments[0].text).toBe("你好");
  });

  it("keeps the reasoning block when scrubbing is off", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse("<think>hmm</think>你好"),
    ) as unknown as typeof fetch;

    const eng = createOpenAIEngine();
    const res = await eng.translate(request);

    expect(res.segments[0].text).toContain("<think>");
  });

  it("strips the reasoning block from a streamed answer", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"<think>let me think"}}]}\n',
        'data: {"choices":[{"delta":{"content":"</think>你好"}}]}\n',
        "data: [DONE]\n",
      ]),
    ) as unknown as typeof fetch;

    const eng = createOpenAIEngine({ stripThinkingTags: true });
    const chunks: string[] = [];
    for await (const seg of eng.translateStream!(request)) {
      chunks.push(seg.text);
    }

    // Not a single emitted chunk may contain the scratchpad — not even the
    // half-written one.
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk).not.toContain("<think>");
      expect(chunk).not.toContain("</think>");
    }
    expect(chunks[chunks.length - 1]).toBe("你好");
  });

  it("holds back a partial opening tag split across deltas", async () => {
    // The provider can split "<think>" across content deltas. The half-written
    // tag must not reach the pane: it is held back until later content shows
    // whether it completes the tag.
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"<thi"}}]}\n',
        'data: {"choices":[{"delta":{"content":"nk>reasoning"}}]}\n',
        'data: {"choices":[{"delta":{"content":"</think>你好"}}]}\n',
        "data: [DONE]\n",
      ]),
    ) as unknown as typeof fetch;

    const eng = createOpenAIEngine({ stripThinkingTags: true });
    const chunks: string[] = [];
    for await (const seg of eng.translateStream!(request)) {
      chunks.push(seg.text);
    }

    for (const chunk of chunks) {
      expect(chunk).not.toContain("<thi");
      expect(chunk).not.toContain("<think>");
      expect(chunk).not.toContain("</think>");
      expect(chunk).not.toContain("reasoning");
    }
    expect(chunks[chunks.length - 1]).toBe("你好");
  });

  it("strips the reasoning block from a streamed multi-segment answer", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"<think>plan"}}]}\n',
        'data: {"choices":[{"delta":{"content":"</think>[[0]]\\n一\\n\\n[[1]]\\n二"}}]}\n',
        "data: [DONE]\n",
      ]),
    ) as unknown as typeof fetch;

    const eng = createOpenAIEngine({ stripThinkingTags: true });
    const chunks: string[] = [];
    for await (const seg of eng.translateStream!({
      pair: { source: "auto", target: "zh-CN" },
      segments: [
        { id: "0", text: "one" },
        { id: "1", text: "two" },
      ],
    })) {
      chunks.push(seg.text);
    }

    for (const chunk of chunks) {
      expect(chunk).not.toContain("<think>");
    }
    expect(chunks.some((c) => c.includes("一"))).toBe(true);
    expect(chunks.some((c) => c.includes("二"))).toBe(true);
  });
});

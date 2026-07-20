import { describe, it, expect, vi } from "vitest";
import type { TranslatedSegment } from "@lumen/core";
import { TranslationError } from "@lumen/core";
import { sseDeltas, parsePartialSegments, createOpenAIEngine } from "../openai.js";

/** Build a ReadableStream that enqueues the given string chunks then closes. */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe("sseDeltas", () => {
  it("parses a normal multi-event SSE stream", async () => {
    const body = streamFromChunks([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n',
      "data: [DONE]\n",
    ]);
    expect(await collect(sseDeltas(body))).toEqual(["Hello", " world"]);
  });

  it("handles a chunk split across event boundaries", async () => {
    // First chunk ends mid-JSON, no newline; second chunk finishes the first
    // event and starts a second one on the same buffer.
    const body = streamFromChunks([
      'data: {"choices":[{"delta":{"content":"He',
      'llo"}}]}\ndata: {"choices":[{"delta":{"content":"!"}}]}\n',
    ]);
    expect(await collect(sseDeltas(body))).toEqual(["Hello", "!"]);
  });

  it("flushes the trailing buffer when the stream ends without a final newline", async () => {
    // No trailing newline on the final event — it must still be parsed.
    const body = streamFromChunks([
      'data: {"choices":[{"delta":{"content":"first"}}]}\n',
      'data: {"choices":[{"delta":{"content":"last"}}]}',
    ]);
    expect(await collect(sseDeltas(body))).toEqual(["first", "last"]);
  });

  it("surfaces an error event as a TranslationError", async () => {
    const makeBody = () =>
      streamFromChunks(['data: {"error":{"message":"rate limited"}}\n']);
    await expect(collect(sseDeltas(makeBody()))).rejects.toBeInstanceOf(
      TranslationError,
    );
    await expect(collect(sseDeltas(makeBody()))).rejects.toThrow(/rate limited/);
  });
});

describe("parsePartialSegments", () => {
  it("returns the trimmed growing text for a single-segment request", () => {
    const segments = [{ id: "1", text: "hi" }];
    expect(parsePartialSegments("  Hello ", segments)).toEqual([
      { id: "1", text: "Hello" },
    ]);
  });

  it("splits multi-segment content by marker, including the still-streaming tail", () => {
    const segments = [{ id: "1", text: "a" }, { id: "2", text: "b" }];
    expect(
      parsePartialSegments("[[1]]\nHello world\n\n[[2]]\nBye wor", segments),
    ).toEqual([
      { id: "1", text: "Hello world" },
      { id: "2", text: "Bye wor" },
    ]);
  });

  it("returns an empty list before the first marker has arrived", () => {
    const segments = [{ id: "1", text: "a" }, { id: "2", text: "b" }];
    expect(parsePartialSegments("partial preamble with no marker yet", segments)).toEqual([]);
  });
});

describe("createOpenAIEngine.translateStream (multi-segment incremental)", () => {
  it("yields incremental per-segment deltas as tokens arrive", async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"[[1]]\\nHello"}}]}\n',
      'data: {"choices":[{"delta":{"content":" world\\n\\n[[2]]\\nBye"}}]}\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n',
      "data: [DONE]\n",
    ];
    const fakeResponse = new Response(streamFromChunks(sseChunks), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        fakeResponse,
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const engine = createOpenAIEngine({ apiKey: "k", model: "m" });
      const req = {
        pair: { source: "en", target: "zh" },
        segments: [
          { id: "1", text: "Hello world" },
          { id: "2", text: "Bye world" },
        ],
      };
      const out: TranslatedSegment[] = [];
      for await (const s of engine.translateStream!(req)) out.push(s);

      const seg1Yields = out.filter((s) => s.id === "1").map((s) => s.text);
      const seg2Yields = out.filter((s) => s.id === "2").map((s) => s.text);

      // True incremental streaming: each segment is emitted more than once as
      // its text grows.
      expect(seg1Yields.length).toBeGreaterThanOrEqual(2);
      expect(seg2Yields.length).toBeGreaterThanOrEqual(2);
      expect(seg1Yields.at(-1)).toBe("Hello world");
      expect(seg2Yields.at(-1)).toBe("Bye world");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("surfaces a mid-stream error event through translateStream", async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"[[1]]\\nHello"}}]}\n',
      'data: {"error":{"message":"context length exceeded"}}\n',
    ];
    const fakeResponse = new Response(streamFromChunks(sseChunks), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        fakeResponse,
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const engine = createOpenAIEngine({ apiKey: "k", model: "m" });
      const req = {
        pair: { source: "en", target: "zh" },
        segments: [{ id: "1", text: "Hello" }],
      };
      await expect(
        (async () => {
          for await (const _ of engine.translateStream!(req)) {
            // drain
          }
        })(),
      ).rejects.toBeInstanceOf(TranslationError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

import { describe, it, expect } from "vitest";
import { translateAll, dedupeSegments } from "./pipeline.js";
import type { Engine, EngineRequest, Segment } from "./types.js";

function mockEngine(): Engine {
  return {
    id: "mock",
    label: "Mock",
    supportsBatch: true,
    async translate(req: EngineRequest) {
      return {
        segments: req.segments.map((s) => ({
          id: s.id,
          text: `[T]${s.text}`,
        })),
      };
    },
  };
}

function seg(id: string, text: string): Segment {
  return { id, text };
}

describe("translateAll", () => {
  it("translates all segments through a batch engine", async () => {
    const engine = mockEngine();
    const result = await translateAll(
      engine,
      { pair: { source: "en", target: "zh" }, segments: [seg("1", "a"), seg("2", "b")] },
      { concurrency: 2, maxBatchSize: 10 },
    );
    expect(result.segments).toEqual([
      { id: "1", text: "[T]a" },
      { id: "2", text: "[T]b" },
    ]);
  });

  it("respects maxBatchSize and preserves order", async () => {
    const engine = mockEngine();
    const segments = Array.from({ length: 10 }, (_, i) => seg(`s${i}`, `t${i}`));
    const result = await translateAll(
      engine,
      { pair: { source: "en", target: "zh" }, segments },
      { concurrency: 3, maxBatchSize: 4 },
    );
    expect(result.segments.map((s) => s.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `s${i}`),
    );
    expect(result.segments.map((s) => s.text)).toEqual(
      Array.from({ length: 10 }, (_, i) => `[T]t${i}`),
    );
  });
});

describe("dedupeSegments", () => {
  it("collapses duplicate text and restores per-id results", () => {
    const segments = [seg("1", "hi"), seg("2", "hi"), seg("3", "yo")];
    const { unique, restore } = dedupeSegments(segments);
    expect(unique.map((s) => s.id)).toEqual(["1", "3"]);
    const restored = restore([
      { id: "1", text: "你好" },
      { id: "3", text: "呦" },
    ]);
    expect(restored).toEqual([
      { id: "1", text: "你好", cached: false },
      { id: "2", text: "你好", cached: true },
      { id: "3", text: "呦", cached: false },
    ]);
  });
});

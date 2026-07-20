import { describe, it, expect } from "vitest";
import { dedupeSegments, normalizeForDedup } from "./pipeline.js";
import type { Segment } from "./types.js";

function seg(id: string, text: string): Segment {
  return { id, text };
}

describe("normalizeForDedup", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeForDedup("  hello   world  ")).toBe("hello world");
    expect(normalizeForDedup("a\t\nb\nc")).toBe("a b c");
  });

  it("applies Unicode NFC so composed and decomposed forms match", () => {
    const composed = "café"; // U+00E9
    const decomposed = "cafe\u0301"; // e + combining acute
    expect(normalizeForDedup(composed)).toBe(normalizeForDedup(decomposed));
    expect(normalizeForDedup(composed)).toBe("café");
  });

  it("decodes common HTML entities", () => {
    expect(normalizeForDedup("a &amp; b")).toBe("a & b");
    expect(normalizeForDedup("&lt;tag&gt;")).toBe("<tag>");
    expect(normalizeForDedup("&quot;hi&quot;")).toBe('"hi"');
    expect(normalizeForDedup("&#39;x&#39;")).toBe("'x'");
    expect(normalizeForDedup("a&nbsp;b")).toBe("a b");
  });

  it("is idempotent", () => {
    const a = "  hello   &amp;   world  ";
    expect(normalizeForDedup(normalizeForDedup(a))).toBe(normalizeForDedup(a));
  });
});

describe("dedupeSegments normalization", () => {
  it("collapses whitespace variants of the same sentence", () => {
    const segments = [
      seg("1", "Hello world"),
      seg("2", "  Hello    world "),
      seg("3", "Hello\tworld"),
    ];
    const { unique, restore } = dedupeSegments(segments);
    expect(unique.map((s) => s.id)).toEqual(["1"]);
    const restored = restore([{ id: "1", text: "你好世界" }]);
    expect(restored).toEqual([
      { id: "1", text: "你好世界", cached: false },
      { id: "2", text: "你好世界", cached: true },
      { id: "3", text: "你好世界", cached: true },
    ]);
  });

  it("collapses Unicode NFC variants", () => {
    const segments = [
      seg("1", "café"), // composed
      seg("2", "cafe\u0301"), // decomposed
    ];
    const { unique, restore } = dedupeSegments(segments);
    expect(unique.map((s) => s.id)).toEqual(["1"]);
    const restored = restore([{ id: "1", text: "coffee" }]);
    expect(restored).toEqual([
      { id: "1", text: "coffee", cached: false },
      { id: "2", text: "coffee", cached: true },
    ]);
  });

  it("collapses HTML-entity-encoded variants", () => {
    const segments = [
      seg("1", "Tom & Jerry"),
      seg("2", "Tom &amp; Jerry"),
      seg("3", "Tom&nbsp;&amp;&nbsp;Jerry"),
    ];
    const { unique, restore } = dedupeSegments(segments);
    expect(unique.map((s) => s.id)).toEqual(["1"]);
    const restored = restore([{ id: "1", text: "T&J" }]);
    expect(restored.map((r) => r.text)).toEqual(["T&J", "T&J", "T&J"]);
    expect(restored.map((r) => r.cached)).toEqual([false, true, true]);
  });

  it("preserves the original text for rendering (only the key is normalized)", () => {
    const segments = [
      seg("1", "  Hello   world  "),
      seg("2", "Hello world"),
    ];
    const { unique } = dedupeSegments(segments);
    // The canonical segment keeps its original (un-normalized) text.
    expect(unique[0].text).toBe("  Hello   world  ");
  });

  it("keeps genuinely distinct texts separate", () => {
    const segments = [seg("1", "Hello world"), seg("2", "Hello, world!")];
    const { unique } = dedupeSegments(segments);
    expect(unique.map((s) => s.id).sort()).toEqual(["1", "2"]);
  });

  it("handles empty input", () => {
    const { unique, restore } = dedupeSegments([]);
    expect(unique).toEqual([]);
    expect(restore([])).toEqual([]);
  });
});

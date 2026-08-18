import { describe, expect, it } from "vitest";
import { chunkText, chunkUserContent } from "../translate";

/**
 * Long selections are chunked before they reach a provider (mirroring
 * `chunkForTranslation` in the macOS app). These tests pin the properties
 * that fix the "17 KB markdown selection times out" bug: short text passes
 * through unchanged, paragraph structure survives, and no chunk ever exceeds
 * the cap — even for an unbroken code block or a giant unbreakable word.
 */

describe("chunkText", () => {
  it("passes short text through as a single chunk", () => {
    expect(chunkText("Hello, world.")).toEqual(["Hello, world."]);
  });

  it("splits long text on paragraph boundaries and round-trips exactly", () => {
    const paras = Array.from(
      { length: 12 },
      (_, i) => `Paragraph number ${i + 1} with a realistic English sentence of reasonable length.`,
    ).join("\n\n");
    const chunks = chunkText(paras, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 500)).toBe(true);
    expect(chunks.join("\n\n")).toBe(paras);
  });

  it("keeps markdown headers with their section", () => {
    const md =
      "## Defects found by the comparison\n\nAll fixed.\n\n## Also corrected\n\nPrompt caching.";
    const chunks = chunkText(md, 1000);
    expect(chunks.join("\n\n")).toBe(md);
    expect(chunks[0]).toContain("## Defects");
  });

  it("hard-splits an unbroken over-long paragraph under the cap", () => {
    const blob = "0123456789abcdef ".repeat(400); // ~16k chars
    const chunks = chunkText(blob, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 1000 && c.length > 0)).toBe(true);
  });

  it("hard-cuts an unbreakable word under the cap and reconstructs it", () => {
    const giant = "x".repeat(2500);
    const chunks = chunkText(giant, 1000);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks.join("")).toBe(giant);
  });

  it("applies the real-world default cap", () => {
    const docs = "word ".repeat(5000); // ~25k chars > 3000
    const chunks = chunkText(docs);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 3000)).toBe(true);
  });
});

describe("chunkUserContent", () => {
  it("passes single-chunk text through verbatim", () => {
    expect(chunkUserContent("Hello", undefined, 0, 1)).toBe("Hello");
  });

  it("adds a part counter and delimiters for later chunks", () => {
    const out = chunkUserContent("Second part", undefined, 1, 2);
    expect(out).toContain("This is part 2 of 2.");
    expect(out).toContain("--- Text to translate ---\nSecond part");
  });

  it("feeds the previous part's translation as read-only context", () => {
    const out = chunkUserContent("Second part", "第一段译文", 1, 2);
    expect(out).toContain("第一段译文");
    expect(out).toContain("do not re-translate");
  });

  it("caps the carried context at 1200 characters", () => {
    const longPrev = "译".repeat(5000);
    const out = chunkUserContent("X", longPrev, 1, 2);
    expect(out).toContain("译".repeat(1200));
    expect(out).not.toContain("译".repeat(1201));
  });
});

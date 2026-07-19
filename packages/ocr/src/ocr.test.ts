import { describe, it, expect } from "vitest";
import { formatOcrResult } from "./ocr.js";
import { clampBbox, mergeCloseBlocks } from "./util.js";
import type { OcrBlock } from "./types.js";

describe("formatOcrResult", () => {
  it("maps full tesseract-style blocks and text", () => {
    const result = formatOcrResult({
      text: "Hello world",
      blocks: [
        {
          text: "Hello",
          bbox: { x0: 10, y0: 10, x1: 50, y1: 30 },
          confidence: 95,
        },
        {
          text: "world",
          bbox: { x0: 60, y0: 10, x1: 110, y1: 30 },
          confidence: 91,
        },
      ],
    });
    expect(result.text).toBe("Hello world");
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]).toEqual({
      text: "Hello",
      bbox: { x0: 10, y0: 10, x1: 50, y1: 30 },
      confidence: 95,
    });
  });

  it("falls back to words when blocks are missing", () => {
    const result = formatOcrResult({
      text: "cat",
      words: [
        {
          text: "cat",
          bbox: { x0: 0, y0: 0, x1: 20, y1: 10 },
          confidence: 88,
        },
      ],
    });
    expect(result.text).toBe("cat");
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].text).toBe("cat");
  });

  it("returns an empty result for malformed input", () => {
    expect(formatOcrResult(null)).toEqual({ text: "", blocks: [] });
    expect(formatOcrResult({})).toEqual({ text: "", blocks: [] });
    expect(formatOcrResult({ text: 123 })).toEqual({ text: "", blocks: [] });
  });
});

describe("clampBbox", () => {
  it("clamps coordinates within image dimensions", () => {
    expect(clampBbox({ x0: -5, y0: -2, x1: 120, y1: 80 }, 100, 60)).toEqual({
      x0: 0,
      y0: 0,
      x1: 100,
      y1: 60,
    });
  });

  it("leaves valid coordinates unchanged", () => {
    expect(clampBbox({ x0: 10, y0: 10, x1: 50, y1: 50 }, 100, 100)).toEqual({
      x0: 10,
      y0: 10,
      x1: 50,
      y1: 50,
    });
  });
});

describe("mergeCloseBlocks", () => {
  function block(text: string, x0: number, y0: number, x1: number, y1: number, confidence = 90): OcrBlock {
    return { text, bbox: { x0, y0, x1, y1 }, confidence };
  }

  it("merges blocks that are within the gap distance", () => {
    const blocks = [block("a", 0, 0, 10, 10), block("b", 11, 0, 21, 10)];
    const merged = mergeCloseBlocks(blocks, 2);
    expect(merged).toHaveLength(1);
    expect(merged[0].bbox).toEqual({ x0: 0, y0: 0, x1: 21, y1: 10 });
    expect(merged[0].text).toBe("a b");
  });

  it("keeps blocks separated by more than the gap", () => {
    const blocks = [block("a", 0, 0, 10, 10), block("b", 30, 0, 40, 10)];
    const merged = mergeCloseBlocks(blocks, 5);
    expect(merged).toHaveLength(2);
  });

  it("returns a copy for negative gaps without merging", () => {
    const blocks = [block("a", 0, 0, 10, 10), block("b", 11, 0, 21, 10)];
    const merged = mergeCloseBlocks(blocks, -1);
    expect(merged).toHaveLength(2);
  });
});

// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { groupIntoParagraphs } from "./paragraphs.js";
import type { PdfPage } from "./types.js";

function makeItem(text: string, x: number, y: number, width: number, height: number) {
  return {
    text,
    str: text,
    transform: [0, 0, 0, 0, x, y],
    width,
    height,
  };
}

describe("groupIntoParagraphs", () => {
  it("groups two lines into one paragraph and a lower block into a second", () => {
    const page: PdfPage = {
      index: 1,
      width: 612,
      height: 792,
      items: [
        makeItem("Hello", 0, 10, 30, 12),
        makeItem("world", 40, 10, 35, 12),
        makeItem("Second", 0, 26, 40, 12),
        makeItem("Separate", 0, 60, 50, 12),
      ],
    };

    const paragraphs = groupIntoParagraphs(page);
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].id).toBe("p1-0");
    expect(paragraphs[0].text).toBe("Hello world Second");
    expect(paragraphs[1].id).toBe("p1-1");
    expect(paragraphs[1].text).toBe("Separate");
    expect(paragraphs[0].bbox.height).toBeGreaterThan(0);
    expect(paragraphs[1].bbox.height).toBeGreaterThan(0);
  });

  it("returns an empty array for an empty page", () => {
    const page: PdfPage = {
      index: 2,
      width: 612,
      height: 792,
      items: [],
    };

    expect(groupIntoParagraphs(page)).toEqual([]);
  });
});

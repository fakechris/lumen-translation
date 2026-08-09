import { describe, it, expect } from "vitest";
import type { Engine, EngineRequest } from "@lumen/core";
import { translatePdf } from "./translate.js";
import type { PdfPage } from "./types.js";

function page(index: number, lines: string[]): PdfPage {
  return {
    index,
    width: 612,
    height: 792,
    // One text item per line; the 100-unit vertical gap keeps every line in
    // its own paragraph under groupIntoParagraphs' gap threshold.
    items: lines.map((text, i) => ({
      text,
      transform: [1, 0, 0, 1, 72, 100 + i * 100],
      width: text.length * 10,
      height: 12,
    })),
  };
}

/** Engine stub that records requests and echoes segment texts back. */
function recordingEngine(captured: EngineRequest[]): Engine {
  return {
    id: "stub",
    label: "stub",
    supportsBatch: true,
    async translate(req: EngineRequest) {
      captured.push(req);
      return {
        segments: req.segments.map((seg) => ({
          id: seg.id,
          text: `T:${seg.text}`,
        })),
      };
    },
  };
}

describe("translatePdf context wiring", () => {
  it("attaches the previous paragraph as context across pages", async () => {
    const captured: EngineRequest[] = [];
    const pages = [page(1, ["Alpha.", "Beta."]), page(2, ["Gamma."])];

    const result = await translatePdf(pages, recordingEngine(captured), {
      source: "en",
      target: "zh",
    });

    const allSegments = captured.flatMap((req) => req.segments);
    const byId = new Map(allSegments.map((seg) => [seg.id, seg]));

    expect(byId.get("p1-0")?.context).toBeUndefined();
    expect(byId.get("p1-1")?.context?.prev).toBe("Alpha.");
    // Page boundary: first paragraph of page 2 sees the last of page 1.
    expect(byId.get("p2-0")?.context?.prev).toBe("Beta.");

    expect(result[1].paragraphs[0].translated).toBe("T:Gamma.");
  });

  it("keeps only the tail of a long previous paragraph", async () => {
    const captured: EngineRequest[] = [];
    const longParagraph = `start-${"x".repeat(500)}-end`;
    const pages = [page(1, [longParagraph, "Next."])];

    await translatePdf(pages, recordingEngine(captured), {
      source: "en",
      target: "zh",
    });

    const allSegments = captured.flatMap((req) => req.segments);
    const prev = allSegments[1].context?.prev ?? "";
    expect(prev.length).toBe(300);
    expect(prev.endsWith("-end")).toBe(true);
    expect(prev.startsWith("start-")).toBe(false);
  });
});

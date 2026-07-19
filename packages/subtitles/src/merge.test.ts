import { describe, it, expect } from "vitest";
import { mergeShortCues } from "./merge.js";
import type { SubtitleCue } from "./types.js";

function cue(id: string, start: number, end: number, text: string): SubtitleCue {
  return { id, start, end, text };
}

describe("mergeShortCues", () => {
  it("merges two short adjacent cues within both duration and char budgets", () => {
    const cues = [
      cue("1", 0, 1.5, "Hi"),
      cue("2", 1.5, 3, "there"),
    ];
    const merged = mergeShortCues(cues);
    expect(merged).toEqual([
      { id: "1", start: 0, end: 3, text: "Hi\nthere" },
    ]);
  });

  it("does not merge when combined duration exceeds maxDuration", () => {
    const cues = [
      cue("1", 0, 3, "Hi"),
      cue("2", 3, 10, "there"),
    ];
    const merged = mergeShortCues(cues, { maxDuration: 5, maxChars: 80 });
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(cues[0]);
    expect(merged[1]).toEqual(cues[1]);
  });

  it("does not merge when combined chars exceed maxChars", () => {
    const longA = "A".repeat(40);
    const longB = "B".repeat(50);
    const cues = [
      cue("1", 0, 1, longA),
      cue("2", 1, 2, longB),
    ];
    const merged = mergeShortCues(cues, { maxDuration: 5, maxChars: 80 });
    expect(merged).toHaveLength(2);
  });

  it("merges runs of more than two cues greedily", () => {
    const cues = [
      cue("1", 0, 1, "a"),
      cue("2", 1, 2, "b"),
      cue("3", 2, 3, "c"),
    ];
    const merged = mergeShortCues(cues);
    expect(merged).toEqual([
      { id: "1", start: 0, end: 3, text: "a\nb\nc" },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(mergeShortCues([])).toEqual([]);
  });

  it("preserves a single cue unchanged", () => {
    const cues = [cue("1", 0, 1, "hi")];
    expect(mergeShortCues(cues)).toEqual(cues);
  });
});

import { describe, it, expect } from "vitest";
import { parseSRT, serializeSRT, parseVTT, serializeVTT } from "./parse.js";

const SRT = `1
00:00:01,000 --> 00:00:02,500
Hello world

2
00:00:03,000 --> 00:00:05,000
This is a test
`;

const VTT = `WEBVTT

cue-1
00:00:01.000 --> 00:00:02.500
Hello world

cue-2
00:00:03.000 --> 00:00:05.000
This is a test
`;

describe("parseSRT", () => {
  it("parses a 2-cue SRT string into cues with correct start/end/text", () => {
    const cues = parseSRT(SRT);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({
      id: "1",
      start: 1,
      end: 2.5,
      text: "Hello world",
    });
    expect(cues[1]).toEqual({
      id: "2",
      start: 3,
      end: 5,
      text: "This is a test",
    });
  });

  it("round-trips SRT through parse → serialize to canonical form", () => {
    const cues = parseSRT(SRT);
    const reserialized = serializeSRT(cues);
    const reparsed = parseSRT(reserialized);
    expect(reparsed).toEqual(cues);
    // Canonical SRT uses 1-based numeric indices and `,` separators.
    expect(reserialized).toContain("00:00:01,000 --> 00:00:02,500");
    expect(reserialized).toContain("1\n");
  });

  it("handles CRLF line endings", () => {
    const crlf = SRT.replace(/\n/g, "\r\n");
    const cues = parseSRT(crlf);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe("Hello world");
  });

  it("handles empty input", () => {
    expect(parseSRT("")).toEqual([]);
  });
});

describe("parseVTT", () => {
  it("parses a 2-cue WebVTT string with WEBVTT header", () => {
    const cues = parseVTT(VTT);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({
      id: "cue-1",
      start: 1,
      end: 2.5,
      text: "Hello world",
    });
    expect(cues[1]).toEqual({
      id: "cue-2",
      start: 3,
      end: 5,
      text: "This is a test",
    });
  });

  it("round-trips VTT through parse → serialize", () => {
    const cues = parseVTT(VTT);
    const reserialized = serializeVTT(cues);
    const reparsed = parseVTT(reserialized);
    expect(reparsed).toEqual(cues);
    expect(reserialized.startsWith("WEBVTT")).toBe(true);
    expect(reserialized).toContain("00:00:01.000 --> 00:00:02.500");
  });

  it("handles VTT timestamps without hours (MM:SS.mmm)", () => {
    const vtt = `WEBVTT

1
00:01.000 --> 00:02.500
Hi
`;
    const cues = parseVTT(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toEqual({ id: "1", start: 1, end: 2.5, text: "Hi" });
  });

  it("skips NOTE blocks", () => {
    const vtt = `WEBVTT

NOTE This is a comment that should be skipped.

1
00:00:01.000 --> 00:00:02.000
Real cue
`;
    const cues = parseVTT(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Real cue");
  });

  it("handles empty input", () => {
    expect(parseVTT("")).toEqual([]);
  });
});

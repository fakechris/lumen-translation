/**
 * SRT / WebVTT parsers and serializers.
 *
 * Both formats share the same essential structure:
 *
 *   <optional cue index / cue identifier>
 *   <start timestamp> --> <end timestamp>
 *   <one or more text lines>
 *   <blank line>
 *
 * SRT timestamps use a comma as the sub-second separator (`HH:MM:SS,mmm`);
 * WebVTT timestamps use a dot (`HH:MM:SS.mmm`) and may omit hours. WebVTT
 * files optionally begin with `WEBVTT` and may contain metadata blocks
 * (`NOTE`, `STYLE`, `REGION`) which we skip.
 */

import type { SubtitleCue } from "./types.js";

const TIMESTAMP_SRT = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
const ARROW_LINE = /-->/;

/** Convert `HH:MM:SS.mmm` (or `MM:SS.mmm`) into seconds. */
function timestampToSeconds(ts: string): number {
  const m = ts.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
  if (!m) {
    const fallback = ts.match(TIMESTAMP_SRT);
    if (!fallback) return NaN;
    const [, h, mm, ss, ms] = fallback;
    return (
      Number(h) * 3600 +
      Number(mm) * 60 +
      Number(ss) +
      Number(ms) / 1000
    );
  }
  const [, h, mm, ss, ms] = m;
  return (
    (h ? Number(h) * 3600 : 0) +
    Number(mm) * 60 +
    Number(ss) +
    Number(ms) / 1000
  );
}

/** Format a seconds value as `HH:MM:SS.mmm` using `sep` as sub-second separator. */
function secondsToTimestamp(seconds: number, sep: string): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds * 1000);
  const ms = total % 1000;
  const totalSeconds = Math.floor(total / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
}

/** Normalize input to LF line endings and trim trailing whitespace per line. */
function normalizeLines(content: string): string[] {
  return content.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * Parse an SRT or WebVTT file. The format is inferred from the presence of a
 * `WEBVTT` header, but both share the same cue block structure so the core
 * parser is identical — only the timestamp separator differs for output.
 */
function parseCues(content: string): SubtitleCue[] {
  const lines = normalizeLines(content);
  const cues: SubtitleCue[] = [];
  let i = 0;
  let cueIndex = 0;

  // Skip WEBVTT header / metadata blocks until we hit the first cue.
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "") {
      i++;
      continue;
    }
    if (line.startsWith("WEBVTT")) {
      i++;
      // Skip WEBVTT metadata block until a blank line.
      while (i < lines.length && lines[i].trim() !== "") i++;
      i++;
      continue;
    }
    if (line.startsWith("NOTE") || line.startsWith("STYLE") || line.startsWith("REGION")) {
      // Skip metadata block until a blank line.
      i++;
      while (i < lines.length && lines[i].trim() !== "") i++;
      i++;
      continue;
    }
    break;
  }

  while (i < lines.length) {
    let line = lines[i].trim();

    // Skip blank lines between cues.
    if (line === "") {
      i++;
      continue;
    }

    // First line may be a timing line (with `-->`) or a cue index/identifier
    // (without `-->`), in which case the next line holds the timings.
    let timingLine = line;
    let cueId: string | null = null;
    if (!ARROW_LINE.test(line)) {
      // Possibly the index/identifier line; the next line should hold timings.
      const nextLine = (lines[i + 1] ?? "").trim();
      if (ARROW_LINE.test(nextLine)) {
        cueId = line;
        timingLine = nextLine;
        i++;
      } else {
        // Unknown block; skip a line and try to recover.
        i++;
        continue;
      }
    }

    const arrowMatch = timingLine.match(/^(.*?)-->\s*(.*)$/);
    if (!arrowMatch) {
      i++;
      continue;
    }
    const startRaw = arrowMatch[1].trim();
    const restRaw = arrowMatch[2].trim();
    // VTT timing lines may contain cue settings after the end timestamp
    // (e.g. `align:start position:0%`). Take the first whitespace-delimited
    // token as the end timestamp.
    const endRaw = restRaw.split(/\s+/)[0] ?? restRaw;

    const start = timestampToSeconds(startRaw);
    const end = timestampToSeconds(endRaw);
    i++;

    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }
    cueIndex++;
    const id = (cueId ?? "").trim() || String(cueIndex);
    cues.push({
      id,
      start,
      end,
      text: textLines.join("\n").trim(),
    });
    // Skip the trailing blank line.
    while (i < lines.length && lines[i].trim() === "") i++;
  }

  return cues;
}

/** Parse an SRT string into cues. */
export function parseSRT(content: string): SubtitleCue[] {
  return parseCues(content);
}

/** Parse a WebVTT string into cues. */
export function parseVTT(content: string): SubtitleCue[] {
  return parseCues(content);
}

/** Serialize cues back to an SRT string (1-based numeric indices). */
export function serializeSRT(cues: SubtitleCue[]): string {
  const blocks: string[] = [];
  cues.forEach((cue, idx) => {
    const index = String(idx + 1);
    const start = secondsToTimestamp(cue.start, ",");
    const end = secondsToTimestamp(cue.end, ",");
    blocks.push(`${index}\n${start} --> ${end}\n${cue.text}`);
  });
  return blocks.join("\n\n") + (blocks.length ? "\n" : "");
}

/** Serialize cues back to a WebVTT string (with `WEBVTT` header). */
export function serializeVTT(cues: SubtitleCue[]): string {
  const blocks: string[] = ["WEBVTT"];
  for (const cue of cues) {
    const start = secondsToTimestamp(cue.start, ".");
    const end = secondsToTimestamp(cue.end, ".");
    blocks.push(`${cue.id}\n${start} --> ${end}\n${cue.text}`);
  }
  return blocks.join("\n\n") + "\n";
}

/**
 * Split cues that exceed a character or duration budget.
 *
 * Splits happen at sentence boundaries (`[.!?。！？]` followed by whitespace).
 * If no boundary is found, the cue is returned unchanged — callers that need
 * harder splitting should use `aiSplitCues`.
 *
 * Timing is distributed proportionally to the length of each resulting chunk.
 */

import type { SubtitleCue } from "./types.js";

export interface SplitOptions {
  /** Maximum characters per cue. Default 60. */
  maxChars?: number;
  /** Maximum duration per cue in seconds. Default 7. */
  maxDuration?: number;
}

const DEFAULT_MAX_CHARS = 60;
const DEFAULT_MAX_DURATION = 7;

const SENTENCE_BOUNDARY = /([.!?。！？])\s+/g;

/**
 * Split a single cue's text at sentence boundaries into chunks whose length
 * is ≤ `maxChars`. If the text has no usable boundary, returns `[text]`.
 */
function splitTextAtSentences(text: string, maxChars: number): string[] {
  // Find boundary positions (index just after the punctuation + whitespace).
  const positions: number[] = [];
  let m: RegExpExecArray | null;
  SENTENCE_BOUNDARY.lastIndex = 0;
  while ((m = SENTENCE_BOUNDARY.exec(text)) !== null) {
    // End of the sentence = index right after the punctuation char (before
    // the whitespace that consumed it). We keep the punctuation with the
    // preceding chunk, so the split point is m.index + 1.
    positions.push(m.index + 1);
  }

  if (positions.length === 0) return [text];

  const chunks: string[] = [];
  let start = 0;
  for (const pos of positions) {
    const chunk = text.slice(start, pos).trim();
    if (chunk.length > maxChars) {
      // The single sentence itself is too long; we have no further boundary,
      // so emit it whole — aiSplitCues is the escape hatch.
      if (chunk) chunks.push(chunk);
    } else if (chunk) {
      chunks.push(chunk);
    }
    start = pos;
  }
  const tail = text.slice(start).trim();
  if (tail) chunks.push(tail);

  // Coalesce tiny adjacent chunks until each is as long as possible without
  // exceeding maxChars, to avoid over-splitting.
  const coalesced: string[] = [];
  for (const chunk of chunks) {
    const last = coalesced[coalesced.length - 1];
    if (last && last.length + 1 + chunk.length <= maxChars) {
      coalesced[coalesced.length - 1] = `${last} ${chunk}`;
    } else {
      coalesced.push(chunk);
    }
  }
  return coalesced.length ? coalesced : [text];
}

/** Distribute `total` seconds across `parts` proportionally to their weights. */
function proportionalTimings(
  start: number,
  end: number,
  weights: number[],
): Array<{ start: number; end: number }> {
  const total = Math.max(0, end - start);
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const out: Array<{ start: number; end: number }> = [];
  let cursor = start;
  for (let i = 0; i < weights.length; i++) {
    const dur = (weights[i] / totalWeight) * total;
    const segEnd = i === weights.length - 1 ? end : cursor + dur;
    out.push({ start: cursor, end: segEnd });
    cursor = segEnd;
  }
  return out;
}

export function splitLongCues(cues: SubtitleCue[], opts: SplitOptions = {}): SubtitleCue[] {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const maxDuration = opts.maxDuration ?? DEFAULT_MAX_DURATION;

  const out: SubtitleCue[] = [];
  for (const cue of cues) {
    const tooLong =
      cue.text.length > maxChars || cue.end - cue.start > maxDuration;
    if (!tooLong) {
      out.push(cue);
      continue;
    }
    const parts = splitTextAtSentences(cue.text, maxChars);
    if (parts.length <= 1) {
      // No usable boundary — leave it alone (let aiSplitCues handle it).
      out.push(cue);
      continue;
    }
    const weights = parts.map((p) => Math.max(1, p.length));
    const timings = proportionalTimings(cue.start, cue.end, weights);
    parts.forEach((text, i) => {
      out.push({
        id: `${cue.id}.${i + 1}`,
        start: timings[i].start,
        end: timings[i].end,
        text,
      });
    });
  }
  return out;
}

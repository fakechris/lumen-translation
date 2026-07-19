/**
 * AI-assisted cue splitting for cues that have no usable sentence boundary.
 *
 * Only cues that are longer than `maxChars` *and* lack a sentence boundary are
 * sent to the engine. The engine is asked to return the text split at natural
 * points separated by `|||`. We then split on `|||`, trim, and distribute the
 * original cue's timing proportionally by chunk length.
 *
 * If the engine returns unparseable output (no `|||`, wrong number of chunks,
 * or chunks that don't reconstruct to roughly the same text), we fall back to
 * the original cue rather than guessing.
 */

import type { Engine, LanguagePair, Segment, TranslatedSegment } from "@lumen/core";

import type { SubtitleCue } from "./types.js";

const SENTENCE_BOUNDARY = /[.!?。！？]\s/;

export interface AiSplitOptions {
  /** Maximum characters per cue. Cues at or below this length are skipped. */
  maxChars: number;
  /** Optional glossary forwarded to the engine (currently unused for prompt). */
  glossary?: import("@lumen/core").GlossaryEntry[];
}

function buildPrompt(text: string, maxChars: number): string {
  return [
    "You are a subtitle segmentation assistant.",
    `Split the following subtitle text into chunks of at most ${maxChars} characters at natural break points.`,
    "Return ONLY the chunks separated by '|||' with no extra commentary.",
    "Do not translate or modify the text — only choose split points.",
    "Text:",
    text,
  ].join("\n");
}

/** Call the engine with a single freeform prompt and return its text output. */
async function promptEngine(
  engine: Engine,
  pair: LanguagePair,
  prompt: string,
): Promise<string | null> {
  const seg: Segment = { id: "ai-split", text: prompt };
  let result: TranslatedSegment | undefined;
  try {
    const res = await engine.translate({
      pair,
      segments: [seg],
      options: { mode: "split" },
    });
    result = res.segments[0];
  } catch {
    return null;
  }
  return result?.text ?? null;
}

/** Normalize whitespace for fair text comparison. */
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

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
    const segEnd = i === weights.length - 1 ? end : cursor + (weights[i] / totalWeight) * total;
    out.push({ start: cursor, end: segEnd });
    cursor = segEnd;
  }
  return out;
}

export async function aiSplitCues(
  engine: Engine,
  cues: SubtitleCue[],
  pair: LanguagePair,
  opts: AiSplitOptions,
): Promise<SubtitleCue[]> {
  const maxChars = opts.maxChars;
  const out: SubtitleCue[] = [];

  for (const cue of cues) {
    const needsSplit = cue.text.length > maxChars && !SENTENCE_BOUNDARY.test(cue.text);
    if (!needsSplit) {
      out.push(cue);
      continue;
    }

    const reply = await promptEngine(engine, pair, buildPrompt(cue.text, maxChars));
    if (!reply) {
      out.push(cue);
      continue;
    }

    const parts = reply
      .split("|||")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    const valid =
      parts.length >= 2 &&
      normalize(parts.join(" ")) === normalize(cue.text) &&
      parts.every((p) => p.length <= maxChars);

    if (!valid) {
      out.push(cue);
      continue;
    }

    const weights = parts.map((p) => Math.max(1, p.length));
    const timings = proportionalTimings(cue.start, cue.end, weights);
    parts.forEach((text, i) => {
      out.push({
        id: `${cue.id}.ai${i + 1}`,
        start: timings[i].start,
        end: timings[i].end,
        text,
      });
    });
  }

  return out;
}

/**
 * Translate subtitle cues through a Lumen `Engine`.
 *
 * Cues are converted to `Segment[]` (id = cue.id, text = cue.text) and routed
 * through `translateAll` from `@lumen/core`. Identical cue text is deduplicated
 * via `dedupeSegments` so we never call the engine twice for the same string.
 */

import type {
  Engine,
  GlossaryEntry,
  LanguagePair,
} from "@lumen/core";
import { dedupeSegments, translateAll } from "@lumen/core";

import type { SubtitleCue, TranslatedCue } from "./types.js";

export interface TranslateCuesOptions {
  /** Terminology hints forwarded to the engine. */
  glossary?: GlossaryEntry[];
  /** Concurrent in-flight requests to the engine. Default 6. */
  concurrency?: number;
  /** Maximum segments per batch request. Default 32. */
  maxBatchSize?: number;
}

export async function translateCues(
  engine: Engine,
  cues: SubtitleCue[],
  pair: LanguagePair,
  opts: TranslateCuesOptions = {},
): Promise<TranslatedCue[]> {
  if (cues.length === 0) return [];

  const segments = cues.map((c) => ({ id: c.id, text: c.text }));
  const { unique, restore } = dedupeSegments(segments);

  const result = await translateAll(
    engine,
    {
      pair,
      segments: unique,
      glossary: opts.glossary,
    },
    { concurrency: opts.concurrency, maxBatchSize: opts.maxBatchSize },
  );

  const restored = restore(result.segments);
  const byId = new Map(restored.map((r) => [r.id, r.text]));

  return cues.map((cue) => ({
    id: cue.id,
    start: cue.start,
    end: cue.end,
    text: byId.get(cue.id) ?? cue.text,
    originalText: cue.text,
  }));
}

import type {
  Engine,
  EngineRequest,
  EngineResult,
  Segment,
  TranslatedSegment,
} from "./types.js";

/**
 * Translate a flat list of segments through an engine, with batching and
 * concurrency control. Batching is engine-driven via `supportsBatch`: engines
 * that don't support batching are called one segment at a time.
 *
 * Single-segment requests go through the same batch path as multi-segment
 * requests (a one-element batch) so there is exactly one code path for
 * engine.translate invocation, consistent error handling, and consistent
 * usage aggregation. The only special case is non-batching engines, which
 * still get one segment per call.
 */
export async function translateAll(
  engine: Engine,
  req: EngineRequest,
  opts: { concurrency?: number; maxBatchSize?: number } = {},
): Promise<EngineResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const maxBatchSize = Math.max(1, opts.maxBatchSize ?? 32);

  if (engine.supportsBatch !== false) {
    const batches = chunk(req.segments, maxBatchSize);
    const results = await mapAsync(batches, async (batch) => {
      return engine.translate({ ...req, segments: batch });
    }, concurrency);
    return mergeResults(results);
  }

  // Non-batching engines: one segment per call.
  const results = await mapAsync(req.segments, async (seg) => {
    return engine.translate({ ...req, segments: [seg] });
  }, concurrency);
  return mergeResults(results);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function mapAsync<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function mergeResults(results: EngineResult[]): EngineResult {
  const segments: TranslatedSegment[] = [];
  let tokens = 0;
  let chars = 0;
  let hasUsage = false;
  for (const r of results) {
    segments.push(...r.segments);
    if (r.usage) {
      hasUsage = true;
      tokens += r.usage.tokens ?? 0;
      chars += r.usage.chars ?? 0;
    }
  }
  return {
    segments,
    usage: hasUsage ? { tokens, chars } : undefined,
  };
}

/**
 * Common HTML entities decoded before comparison. Decoded with a plain string
 * replace (not DOMParser) so this stays DOM-agnostic and works in workers /
 * non-browser hosts.
 */
const HTML_ENTITIES: ReadonlyArray<[string, string]> = [
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&nbsp;", " "],
];

/**
 * Normalize text for dedupe comparison. We do NOT mutate the original
 * segment text (callers render that); the normalized form is only used as the
 * dedup key.
 *
 * Normalization steps:
 * 1. Decode the common HTML entities listed above.
 * 2. Unicode NFC normalization (so canonical and composed forms match).
 * 3. Collapse internal runs of whitespace to a single space.
 * 4. Trim leading / trailing whitespace.
 */
export function normalizeForDedup(text: string): string {
  let out = text;
  for (const [entity, ch] of HTML_ENTITIES) {
    if (out.includes(entity)) out = out.split(entity).join(ch);
  }
  out = out.normalize("NFC");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

function isEmptyContext(context: Segment["context"]): boolean {
  if (context == null) return true;
  return context.prev === undefined && context.next === undefined;
}

function dedupKey(seg: Segment): string {
  const normalized = normalizeForDedup(seg.text);
  return isEmptyContext(seg.context)
    ? normalized
    : `${normalized}\u0000${JSON.stringify(seg.context)}`;
}

/** Deduplicate segments by text content to avoid duplicate API calls. */
export function dedupeSegments(segments: Segment[]): {
  unique: Segment[];
  restore: (translated: TranslatedSegment[]) => TranslatedSegment[];
} {
  const byKey = new Map<string, Segment>();
  const byId = new Map<string, string>(); // id -> canonicalId
  for (const seg of segments) {
    const key = dedupKey(seg);
    const canonical = byKey.get(key);
    if (canonical) {
      byId.set(seg.id, canonical.id);
    } else {
      byKey.set(key, seg);
      byId.set(seg.id, seg.id);
    }
  }
  const unique = Array.from(byKey.values());
  const restore = (translated: TranslatedSegment[]): TranslatedSegment[] => {
    const textById = new Map(translated.map((t) => [t.id, t.text]));
    return segments.map((seg) => ({
      id: seg.id,
      text: textById.get(byId.get(seg.id)!) ?? seg.text,
      cached: byId.get(seg.id) !== seg.id,
    }));
  };
  return { unique, restore };
}

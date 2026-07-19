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
 */
export async function translateAll(
  engine: Engine,
  req: EngineRequest,
  opts: { concurrency?: number; maxBatchSize?: number } = {},
): Promise<EngineResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const maxBatchSize = Math.max(1, opts.maxBatchSize ?? 32);

  if (engine.supportsBatch !== false && req.segments.length > 1) {
    const batches = chunk(req.segments, maxBatchSize);
    const results = await mapAsync(batches, async (batch) => {
      return engine.translate({ ...req, segments: batch });
    }, concurrency);
    return mergeResults(results);
  }

  // One-by-one path.
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

/** Deduplicate segments by text content to avoid duplicate API calls. */
export function dedupeSegments(segments: Segment[]): {
  unique: Segment[];
  restore: (translated: TranslatedSegment[]) => TranslatedSegment[];
} {
  const byText = new Map<string, Segment>();
  const byId = new Map<string, string>(); // id -> canonicalId
  for (const seg of segments) {
    const canonical = byText.get(seg.text);
    if (canonical) {
      byId.set(seg.id, canonical.id);
    } else {
      byText.set(seg.text, seg);
      byId.set(seg.id, seg.id);
    }
  }
  const unique = Array.from(byText.values());
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

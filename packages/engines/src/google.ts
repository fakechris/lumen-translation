import type { Engine, EngineRequest, TranslatedSegment } from "@lumen/core";
import { TranslationError } from "@lumen/core";
import { EngineFetchError, fetchWithRetry } from "./fetch-utils.js";

/** Query params supported by the free google translate endpoint. */
interface GoogleRpcResponse {
  data?: Array<Array<{ 0?: string }>>;
}

function isEmptyText(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * Google Translate free endpoint. No API key required. Suitable as a default
 * out-of-the-box engine. Subject to rate limits and ToS considerations; users
 * can switch engines in settings.
 */
export interface GoogleEngineOptions {
  endpoint?: string;
  /** Request timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Max retries on 429/503 (default 3). */
  maxRetries?: number;
}

/**
 * Conservative URL length limit. Browsers and proxies typically enforce ~2k
 * char limits for GET URLs; stay safely under that so long prompts don't get
 * silently truncated or rejected.
 */
const MAX_GET_URL_LENGTH = 2000;

export function createGoogleEngine(opts: GoogleEngineOptions = {}): Engine {
  const endpoint =
    opts.endpoint ??
    "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t";
  const fetchOpts = {
    engineId: "google",
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
  };
  return {
    id: "google",
    label: "Google Translate",
    supportsBatch: true,
    async translate(req: EngineRequest): Promise<{ segments: TranslatedSegment[] }> {
      const { pair, segments } = req;
      if (segments.length === 0) return { segments: [] };
      if (segments.every((s) => isEmptyText(s.text))) {
        return { segments: segments.map((s) => ({ id: s.id, text: s.text })) };
      }
      // Google's free `translate_a/single` endpoint only accepts GET with the
      // query in the URL, so a single huge request can exceed URL length
      // limits. Split into sub-batches whose URL stays under
      // MAX_GET_URL_LENGTH, then stitch the per-batch results back together.
      const out: TranslatedSegment[] = new Array(segments.length);
      const sl = encodeURIComponent(pair.source === "auto" ? "auto" : pair.source);
      const tl = encodeURIComponent(pair.target);
      for (let i = 0; i < segments.length; ) {
        const batch: typeof segments = [];
        while (i + batch.length < segments.length) {
          const candidate = [...batch, segments[i + batch.length]];
          const joined = candidate.map((s) => s.text).join("\n\n@@@\n\n");
          const url =
            `${endpoint}&sl=${sl}&tl=${tl}&q=${encodeURIComponent(joined)}`;
          if (batch.length > 0 && url.length > MAX_GET_URL_LENGTH) break;
          batch.push(segments[i + batch.length]);
        }
        const joined = batch.map((s) => s.text).join("\n\n@@@\n\n");
        const url =
          `${endpoint}&sl=${sl}&tl=${tl}&q=${encodeURIComponent(joined)}`;
        let res: Response;
        try {
          res = await fetchWithRetry(url, { method: "GET" }, fetchOpts);
        } catch (err) {
          if (err instanceof TranslationError) throw err;
          throw new TranslationError(
            `Google network error: ${(err as Error).message}`,
            "google",
            err,
          );
        }
        if (!res.ok) {
          throw new EngineFetchError(`Google HTTP ${res.status}`, "google", "http", res.status);
        }
        const json = (await res.json()) as GoogleRpcResponse;
        const rows = json.data ?? [];
        const text = rows.map((row) => row?.[0] ?? "").join("");
        if (text.trim().length === 0 && batch.some((s) => !isEmptyText(s.text))) {
          throw new TranslationError("Google returned an empty translation response", "google");
        }
        const parts = text.split(/\n\n@@@\n\n/);
        for (let j = 0; j < batch.length; j++) {
          const seg = batch[j];
          const src = seg.text;
          if (isEmptyText(src)) {
            out[i + j] = { id: seg.id, text: src };
          } else if (parts[j] === undefined) {
            throw new TranslationError(
              `Google returned no translation for segment ${seg.id}`,
              "google",
            );
          } else {
            out[i + j] = { id: seg.id, text: parts[j] };
          }
        }
        i += batch.length;
      }
      return { segments: out };
    },
  };
}

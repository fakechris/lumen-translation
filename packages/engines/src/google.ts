import type { Engine, EngineRequest, TranslatedSegment } from "@lumen/core";
import { TranslationError } from "@lumen/core";

/** Query params supported by the free google translate endpoint. */
interface GoogleRpcResponse {
  data?: Array<Array<{ 0?: string }>>;
}

/**
 * Google Translate free endpoint. No API key required. Suitable as a default
 * out-of-the-box engine. Subject to rate limits and ToS considerations; users
 * can switch engines in settings.
 */
export interface GoogleEngineOptions {
  endpoint?: string;
}

export function createGoogleEngine(opts: GoogleEngineOptions = {}): Engine {
  const endpoint =
    opts.endpoint ??
    "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t";
  return {
    id: "google",
    label: "Google Translate",
    supportsBatch: true,
    async translate(req: EngineRequest): Promise<{ segments: TranslatedSegment[] }> {
      const { pair, segments } = req;
      if (segments.length === 0) return { segments: [] };
      // Google's free endpoint accepts one source text per request; we batch
      // by concatenating with a separator and splitting the response, which is
      // what the endpoint natively returns (array of sentence tuples).
      const joined = segments.map((s) => s.text).join("\n\n@@@\n\n");
      const url =
        `${endpoint}&sl=${encodeURIComponent(pair.source === "auto" ? "auto" : pair.source)}` +
        `&tl=${encodeURIComponent(pair.target)}&q=${encodeURIComponent(joined)}`;
      const res = await safeFetch(url, { method: "GET" });
      const json = (await res.json()) as GoogleRpcResponse;
      const text = (json.data ?? [])
        .map((row) => row?.[0] ?? "")
        .join("");
      const parts = text.split(/\n\n@@@\n\n/);
      const out: TranslatedSegment[] = segments.map((seg, i) => ({
        id: seg.id,
        text: parts[i] ?? seg.text,
      }));
      return { segments: out };
    },
  };
}

async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new TranslationError(`HTTP ${res.status}`, "google");
    }
    return res;
  } catch (err) {
    if (err instanceof TranslationError) throw err;
    throw new TranslationError(
      `Network error: ${(err as Error).message}`,
      "google",
      err,
    );
  }
}

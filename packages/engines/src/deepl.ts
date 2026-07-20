import type { Engine, EngineRequest, TranslatedSegment } from "@lumen/core";
import { TranslationError } from "@lumen/core";
import { fetchWithRetry } from "./fetch-utils.js";

/** DeepL (free or pro API). Requires an API key. */
export interface DeepLEngineOptions {
  apiKey: string;
  /** Use the free endpoint (default) or pro. */
  pro?: boolean;
  endpoint?: string;
  /** Request timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Max retries on 429/503 (default 3). */
  maxRetries?: number;
}

interface DeepLResponse {
  translations?: Array<{ text: string }>;
  message?: string;
}

export function createDeepLEngine(opts: DeepLEngineOptions): Engine {
  if (!opts.apiKey) {
    return {
      id: "deepl",
      label: "DeepL",
      async translate() {
        throw new TranslationError("DeepL API key is not configured", "deepl");
      },
    };
  }
  const endpoint =
    opts.endpoint ??
    (opts.pro
      ? "https://api.deepl.com/v2/translate"
      : "https://api-free.deepl.com/v2/translate");
  const fetchOpts = {
    engineId: "deepl",
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
  };
  return {
    id: "deepl",
    label: "DeepL",
    supportsBatch: true,
    async translate(req) {
      const { pair, segments } = req;
      if (segments.length === 0) return { segments: [] };
      const params = new URLSearchParams();
      params.set("target_lang", pair.target.toUpperCase());
      if (pair.source && pair.source !== "auto") {
        params.set("source_lang", pair.source.toUpperCase());
      }
      for (const seg of segments) params.append("text", seg.text);
      const res = await fetchWithRetry(
        endpoint,
        {
          method: "POST",
          headers: {
            Authorization: `DeepL-Auth-Key ${opts.apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
        },
        fetchOpts,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as DeepLResponse;
        throw new TranslationError(
          `DeepL HTTP ${res.status}: ${body.message ?? ""}`,
          "deepl",
        );
      }
      const json = (await res.json()) as DeepLResponse;
      const out: TranslatedSegment[] = segments.map((seg, i) => ({
        id: seg.id,
        text: json.translations?.[i]?.text ?? seg.text,
      }));
      return { segments: out };
    },
  };
}

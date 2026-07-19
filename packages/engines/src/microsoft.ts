import type { Engine, EngineRequest, TranslatedSegment } from "@lumen/core";
import { TranslationError } from "@lumen/core";

/**
 * Microsoft Translator via the public Edge auth token endpoint. No API key
 * required. Used by the Edge browser's built-in translator.
 */
export interface MicrosoftEngineOptions {
  endpoint?: string;
}

interface MicrosoftTranslation {
  translations?: Array<{ text: string }>;
}

export function createMicrosoftEngine(
  opts: MicrosoftEngineOptions = {},
): Engine {
  const endpoint =
    opts.endpoint ?? "https://api.cognitive.microsofttranslator.com/translate";
  return {
    id: "microsoft",
    label: "Microsoft Translator",
    supportsBatch: true,
    async translate(req) {
      const { pair, segments } = req as EngineRequest;
      if (segments.length === 0) return { segments: [] };
      const token = await fetchEdgeToken();
      const url =
        `${endpoint}?api-version=3.0&to=${encodeURIComponent(pair.target)}` +
        (pair.source && pair.source !== "auto"
          ? `&from=${encodeURIComponent(pair.source)}`
          : "");
      const body = segments.map((s) => ({ Text: s.text }));
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new TranslationError(`HTTP ${res.status}`, "microsoft");
      }
      const json = (await res.json()) as MicrosoftTranslation[];
      const out: TranslatedSegment[] = segments.map((seg, i) => ({
        id: seg.id,
        text: json[i]?.translations?.[0]?.text ?? seg.text,
      }));
      return { segments: out };
    },
  };
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function fetchEdgeToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value;
  }
  const res = await fetch(
    "https://edge.microsoft.com/translate/auth",
    { method: "GET" },
  );
  if (!res.ok) {
    throw new TranslationError(
      `Failed to fetch Microsoft auth token: HTTP ${res.status}`,
      "microsoft",
    );
  }
  const value = (await res.text()).trim();
  // Tokens last ~10 minutes; refresh early.
  cachedToken = { value, expiresAt: now + 8 * 60 * 1000 };
  return value;
}

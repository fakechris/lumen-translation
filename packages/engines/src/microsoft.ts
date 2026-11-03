import type { Engine, EngineRequest, TranslatedSegment } from "@lumen/core";
import { TranslationError } from "@lumen/core";
import { EngineFetchError, fetchWithRetry } from "./fetch-utils.js";

/**
 * Microsoft Translator via the public Edge auth token endpoint. No API key
 * required. Used by the Edge browser's built-in translator.
 */
export interface MicrosoftEngineOptions {
  endpoint?: string;
  /** Request timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Max retries on 429/503 (default 3). */
  maxRetries?: number;
  /**
   * Wall-clock budget for this engine's retries (default 1500 ms). Once spent,
   * the response is handed back so the fallback chain can move on.
   */
  retryBudgetMs?: number;
}

interface MicrosoftTranslation {
  translations?: Array<{ text: string }>;
}

export function createMicrosoftEngine(
  opts: MicrosoftEngineOptions = {},
): Engine {
  const endpoint =
    opts.endpoint ?? "https://api.cognitive.microsofttranslator.com/translate";
  const fetchOpts = {
    engineId: "microsoft",
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
    retryBudgetMs: opts.retryBudgetMs,
  };
  return {
    id: "microsoft",
    label: "Microsoft Translator",
    supportsBatch: true,
    async translate(req) {
      const { pair, segments } = req as EngineRequest;
      if (segments.length === 0) return { segments: [] };
      if (segments.every((s) => s.text.trim().length === 0)) {
        return { segments: segments.map((s) => ({ id: s.id, text: s.text })) };
      }
      const token = await fetchEdgeToken(opts.timeoutMs, opts.maxRetries, opts.retryBudgetMs);
      const url =
        `${endpoint}?api-version=3.0&to=${encodeURIComponent(pair.target)}` +
        (pair.source && pair.source !== "auto"
          ? `&from=${encodeURIComponent(pair.source)}`
          : "");
      const body = segments.map((s) => ({ Text: s.text }));
      const res = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        },
        fetchOpts,
      );
      if (!res.ok) {
        throw new EngineFetchError(`Microsoft HTTP ${res.status}`, "microsoft", "http", res.status);
      }
      const json = (await res.json()) as MicrosoftTranslation[];
      const out: TranslatedSegment[] = segments.map((seg, i) => {
        if (seg.text.trim().length === 0) {
          return { id: seg.id, text: seg.text };
        }
        const translation = json[i]?.translations?.[0]?.text;
        if (translation === undefined) {
          throw new TranslationError(
            `Microsoft returned no translation for segment ${seg.id}`,
            "microsoft",
          );
        }
        return { id: seg.id, text: translation };
      });
      return { segments: out };
    },
  };
}

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * The Edge auth endpoint is a moving target. When it disappears — it answers
 * 404 today — every translation through this engine is impossible until it
 * comes back, and no amount of retrying changes that.
 *
 * Remember it so the fallback chain doesn't pay the round trip again on every
 * request. The flag expires so a returning endpoint is picked up again
 * without restarting the app.
 */
let edgeAuthDownUntil = 0;

/** How long a dead Edge auth endpoint is taken at face value. */
const EDGE_AUTH_REPROBE_MS = 10 * 60 * 1000;

const EDGE_AUTH_ENDPOINT = "https://edge.microsoft.com/translate/auth";

/** The engine is unusable; the user can do nothing about a dead endpoint. */
function edgeAuthUnavailable(status?: number): EngineFetchError {
  return new EngineFetchError(
    "Microsoft Translator is unavailable: its Edge auth endpoint is gone",
    "microsoft",
    "unavailable",
    status,
  );
}

async function fetchEdgeToken(
  timeoutMs?: number,
  maxRetries?: number,
  retryBudgetMs?: number,
): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.value;
  }
  // Known dead: fail immediately so the chain moves on instead of burning
  // a round trip on every translation.
  if (now < edgeAuthDownUntil) {
    throw edgeAuthUnavailable();
  }
  const res = await fetchWithRetry(
    EDGE_AUTH_ENDPOINT,
    { method: "GET" },
    { engineId: "microsoft", timeoutMs, maxRetries, retryBudgetMs },
  );
  if (res.status === 404 || res.status === 410) {
    edgeAuthDownUntil = Date.now() + EDGE_AUTH_REPROBE_MS;
    throw edgeAuthUnavailable(res.status);
  }
  if (!res.ok) {
    throw new EngineFetchError(
      `Failed to fetch Microsoft auth token: HTTP ${res.status}`,
      "microsoft",
      "http",
      res.status,
    );
  }
  const value = (await res.text()).trim();
  // Tokens last ~10 minutes; refresh early.
  cachedToken = { value, expiresAt: now + 8 * 60 * 1000 };
  return value;
}

/**
 * Probe the Edge auth endpoint ahead of the first real request.
 *
 * The endpoint's state (alive, rate-limited, or gone) is only knowable by
 * asking it. Doing that in the background means the first translation of the
 * session starts with the answer already in hand — instead of paying the
 * round trip while the user waits for the hotkey to produce text.
 *
 * Never throws: a failed probe just means the next request learns the state
 * itself.
 */
export async function warmUpMicrosoftEngine(opts: MicrosoftEngineOptions = {}): Promise<void> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return;
  if (now < edgeAuthDownUntil) return;
  try {
    await fetchEdgeToken(opts.timeoutMs, opts.maxRetries, opts.retryBudgetMs);
  } catch {
    // The probe is best-effort; the failure mode is handled by the real call.
  }
}

import type { Engine, EngineRequest, TranslatedSegment } from "@lumen/core";
import { TranslationError } from "@lumen/core";
import { EngineFetchError, fetchWithRetry } from "./fetch-utils.js";

/**
 * Microsoft Translator through Edge's public translation endpoint.
 *
 * The endpoint used to require a token from `edge.microsoft.com/translate/auth`.
 * Microsoft retired that service on 2026-07-30 — the auth endpoint answers 404
 * — but the translation endpoint itself still works and, as of the Comet
 * extension's implementation, needs no token at all:
 *
 *   POST https://edge.microsoft.com/translate/translatetext?to=<lang>&isEnterpriseClient=false
 *   body: `["text one", "text two"]`
 *
 * The body is a plain array of *strings*; the `[{ "Text": "..." }]` shape the
 * Azure Cognitive Translator API expects is rejected with HTTP 400.
 *
 * The response is `[{ detectedLanguage, translations: [{ text, to, sentLen }] }]`,
 * one entry per input text.
 */

/** Edge's token-free translation endpoint. */
const EDGE_ENDPOINT = "https://edge.microsoft.com/translate/translatetext";

/** Host of the Azure Cognitive Translator API, which the catalog still names. */
const COGNITIVE_HOST = "api.cognitive.microsofttranslator.com";

/**
 * Language codes Edge names differently from our UI.
 *
 * Everything else is passed through unchanged: the endpoint accepts the plain
 * code for the languages the UI offers (`zh-CN`, `ja`, `ko`, …).
 */
const EDGE_LANG_MAP: Record<string, string> = {
  zh: "zh-Hans",
  "zh-cn": "zh-Hans",
  "zh-hans": "zh-Hans",
  "zh-tw": "zh-Hant",
  "zh-hant": "zh-Hant",
  "zh-hk": "zh-Hant",
};

/**
 * Microsoft Translator via Edge's public endpoint. No API key required.
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

/** Map one of our language codes onto the code Edge expects. */
function edgeLang(code: string): string {
  return EDGE_LANG_MAP[code.toLowerCase()] ?? code;
}

/**
 * Resolve the endpoint the engine talks to.
 *
 * The generated provider catalog still names the Azure Cognitive Translator
 * API, which cannot serve this engine without a key of its own. That file
 * must not be hand-edited, so the swap happens here by host + path.
 */
function resolveEndpoint(raw: string | undefined): string {
  const endpoint = raw ?? EDGE_ENDPOINT;
  try {
    const url = new URL(endpoint);
    if (url.hostname === COGNITIVE_HOST && url.pathname === "/translate") {
      return EDGE_ENDPOINT;
    }
  } catch {
    // A malformed custom endpoint: keep it as given and let the request fail.
  }
  return endpoint;
}

/**
 * The Edge endpoint is a moving target. When it disappears, every translation
 * through this engine is impossible until it comes back, and no amount of
 * retrying changes that.
 *
 * Remember it so the fallback chain doesn't pay the round trip again on every
 * request. The flag expires so a returning endpoint is picked up again
 * without restarting the app.
 */
let edgeDownUntil = 0;

/** How long a dead Edge endpoint is taken at face value. */
const EDGE_REPROBE_MS = 10 * 60 * 1000;

/** The engine is unusable; the user can do nothing about a dead endpoint. */
function edgeUnavailable(status?: number): EngineFetchError {
  return new EngineFetchError(
    "Microsoft Translator is unavailable: its Edge endpoint is gone",
    "microsoft",
    "unavailable",
    status,
  );
}

export function createMicrosoftEngine(
  opts: MicrosoftEngineOptions = {},
): Engine {
  const endpoint = resolveEndpoint(opts.endpoint);
  const fetchOpts = {
    engineId: "microsoft",
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
    retryBudgetMs: opts.retryBudgetMs,
  };

  /** Build the request for one batch of texts. */
  function buildRequest(
    pair: EngineRequest["pair"],
    texts: string[],
  ): { url: string; body: string } {
    const url = new URL(endpoint);
    url.searchParams.set("to", edgeLang(pair.target));
    if (pair.source && pair.source !== "auto") {
      const from = edgeLang(pair.source);
      if (from) url.searchParams.set("from", from);
    }
    url.searchParams.set("isEnterpriseClient", "false");
    return { url: url.toString(), body: JSON.stringify(texts) };
  }

  /** Send one request and return the raw translation rows. */
  async function request(
    pair: EngineRequest["pair"],
    texts: string[],
  ): Promise<MicrosoftTranslation[]> {
    if (Date.now() < edgeDownUntil) {
      throw edgeUnavailable();
    }
    const { url, body } = buildRequest(pair, texts);
    const res = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          Accept: "*/*",
        },
        body,
      },
      fetchOpts,
    );
    if (res.status === 404 || res.status === 410) {
      edgeDownUntil = Date.now() + EDGE_REPROBE_MS;
      throw edgeUnavailable(res.status);
    }
    if (!res.ok) {
      throw new EngineFetchError(
        `Microsoft HTTP ${res.status}`,
        "microsoft",
        "http",
        res.status,
      );
    }
    const json = (await res.json()) as MicrosoftTranslation[];
    if (!Array.isArray(json)) {
      throw new TranslationError(
        "Microsoft returned an unexpected response",
        "microsoft",
      );
    }
    return json;
  }

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
      const json = await request(pair, segments.map((s) => s.text));
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

/**
 * Probe the Edge endpoint ahead of the first real request.
 *
 * The endpoint's state (alive, rate-limited, or gone) is only knowable by
 * asking it. Doing that in the background means the first translation of the
 * session starts with the answer already in hand — instead of paying the
 * round trip while the user waits for the hotkey to produce text.
 *
 * Never throws: a failed probe just means the next request learns the state
 * itself.
 */
export async function warmUpMicrosoftEngine(
  opts: MicrosoftEngineOptions = {},
): Promise<void> {
  try {
    const eng = createMicrosoftEngine(opts);
    await eng.translate({
      pair: { source: "auto", target: "en" },
      segments: [{ id: "warmup", text: "a" }],
    });
  } catch {
    // The probe is best-effort; the failure mode is handled by the real call.
  }
}

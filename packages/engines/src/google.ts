import type { Engine, EngineRequest, TranslatedSegment } from "@lumen/core";
import { TranslationError } from "@lumen/core";
import { EngineFetchError, fetchWithRetry } from "./fetch-utils.js";

/**
 * Google's free translation endpoints.
 *
 * Two keyless upstream paths exist today:
 *
 *  - `POST https://translate.googleapis.com/translate_a/t` with a
 *    form-urlencoded body (`q=<text>`). This is the path the Comet extension
 *    uses when its "browser API" mode is off. It answers in ~0.4 s and — being
 *    a POST — is not bound by URL length limits, so a long text goes out in one
 *    request instead of being split to fit a 2 kB URL.
 *
 *  - `POST https://translate-pa.googleapis.com/v1/translateHtml`, Google's
 *    "browser API". It needs the public web key that Google's own web client
 *    ships with, and it takes a *list* of texts, answering one translation per
 *    text. It is the fallback here: when the primary path is throttled or
 *    broken, this one usually still answers.
 *
 * The vendored provider catalog still advertises the older
 * `GET /translate_a/single` path, and that file must not be hand-edited (it is
 * regenerated from lumen-suite by `scripts/sync-provider-catalog.mjs`), so the
 * endpoint is rewritten here by host + path. Every app that goes through
 * `@lumen/engines` therefore uses the current upstream path without anyone
 * touching the generated catalog.
 */

/** Host of the keyless free endpoint. */
const GOOGLE_HOST = "translate.googleapis.com";

/** Path the generated catalog still points at. */
const LEGACY_SINGLE_PATH = "/translate_a/single";

/** Current path of the keyless free endpoint. */
const PRIMARY_PATH = "/translate_a/t";

/** Google's "browser API" — the fallback path. */
export const GOOGLE_BROWSER_API_ENDPOINT =
  "https://translate-pa.googleapis.com/v1/translateHtml";

/**
 * The public web key Google's own web client ships with.
 *
 * It is not a user credential — it is embedded in the browser bundle of
 * Google's translate UI — and the browser-API path rejects requests without
 * it. Deployments that want a different key can pass `browserApiKey`.
 */
export const GOOGLE_BROWSER_API_KEY =
  "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520";

/** Separator used to keep segment boundaries inside one translated blob. */
const SEGMENT_SEPARATOR = "\n\n@@@\n\n";

/**
 * Source characters per request on the primary path. The endpoint accepted an
 * 8 kB body in testing, but a single modest request keeps the response small
 * and the round trip short.
 */
const MAX_BATCH_CHARS = 4000;

/** Query params supported by the free google translate endpoint. */
type GoogleRpcResponse = unknown;

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
  /**
   * Wall-clock budget for this engine's retries (default 1500 ms). Once spent,
   * the response is handed back so the fallback chain can move on.
   */
  retryBudgetMs?: number;
  /** Public API key for the browser-API fallback (default Google's public one). */
  browserApiKey?: string;
}

interface ResolvedEndpoint {
  /** Base URL, without the per-request `sl` / `tl` query. */
  base: string;
  method: "GET" | "POST";
}

/**
 * Resolve the endpoint the engine talks to.
 *
 * Google's own host is always served by the current POST path; a custom
 * endpoint (a self-hosted proxy, say) keeps the legacy GET contract so
 * existing setups keep working.
 */
function resolveEndpoint(raw: string | undefined): ResolvedEndpoint {
  const endpoint = raw ?? `https://${GOOGLE_HOST}${PRIMARY_PATH}`;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    // A malformed custom endpoint: keep it as given and let the request fail.
    return { base: endpoint, method: "GET" };
  }
  if (url.hostname !== GOOGLE_HOST) {
    return { base: endpoint, method: "GET" };
  }
  if (url.pathname.endsWith(LEGACY_SINGLE_PATH)) {
    url.pathname =
      url.pathname.slice(0, -LEGACY_SINGLE_PATH.length) + PRIMARY_PATH;
  }
  // The free endpoint needs the gtx client parameters; the generated catalog
  // does not carry them, so make sure they are there.
  if (!url.searchParams.has("client")) url.searchParams.set("client", "gtx");
  if (!url.searchParams.has("dt")) url.searchParams.set("dt", "t");
  return { base: url.toString(), method: "POST" };
}

/**
 * Every upstream shape reduces to "the concatenation of the translated
 * strings", but the two keyless paths differ in where the language code sits:
 *
 *  - current path  → `[["译文", "srcLang"]]` — one entry per request, and the
 *    second element of the pair is the detected language, *not* more text.
 *  - legacy path   → `[[["译文", "原文", ...], ...], null, "srcLang", ...]` —
 *    one entry per sentence, each a tuple whose first element is the text.
 */
function parsePrimaryText(json: GoogleRpcResponse): string {
  if (!Array.isArray(json)) return "";
  const out: string[] = [];
  for (const entry of json) {
    if (!Array.isArray(entry) || entry.length === 0) continue;
    if (Array.isArray(entry[0])) {
      // Legacy shape: a list of sentence tuples.
      for (const tuple of entry) {
        if (Array.isArray(tuple) && typeof tuple[0] === "string") {
          out.push(tuple[0]);
        }
      }
      continue;
    }
    // Current shape: a [text, srcLang] pair.
    if (typeof entry[0] === "string") out.push(entry[0]);
  }
  return out.join("");
}

/**
 * The browser API takes a list of texts and answers with one translation per
 * text: `[["译文1", "译文2"], ["en", "en"]]`.
 */
function parseBrowserApiTexts(json: GoogleRpcResponse): string[] {
  const first = Array.isArray(json) ? json[0] : undefined;
  if (!Array.isArray(first)) return [];
  return first.map((value) => (typeof value === "string" ? value : ""));
}

/** True when the failure is "the user stopped waiting", not "it did not work". */
function isCancellation(err: unknown): boolean {
  return (
    err instanceof EngineFetchError &&
    (err.kind === "aborted" || err.kind === "timeout")
  );
}

/**
 * The browser-API path answered; use it directly from now on.
 *
 * Remembering it matters for the hotkey: after the primary path starts
 * failing, every translation would otherwise pay a doomed round trip first.
 */
let browserApiPreferred = false;

/**
 * The free endpoint itself is gone. Nothing the user can do about it, and no
 * amount of retrying brings it back — so the fallback chain should skip this
 * engine instead of reporting a raw 404.
 */
function unavailable(status?: number): EngineFetchError {
  return new EngineFetchError(
    "Google Translate endpoint is unavailable",
    "google",
    "unavailable",
    status,
  );
}

export function createGoogleEngine(opts: GoogleEngineOptions = {}): Engine {
  const endpoint = resolveEndpoint(opts.endpoint);
  const browserApiKey = opts.browserApiKey ?? GOOGLE_BROWSER_API_KEY;
  const fetchOpts = {
    engineId: "google",
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
    retryBudgetMs: opts.retryBudgetMs,
  };

  /** Ask the keyless primary path for one blob of text. */
  async function requestPrimary(joined: string, sl: string, tl: string): Promise<string> {
    const url = new URL(endpoint.base);
    url.searchParams.set("sl", sl);
    url.searchParams.set("tl", tl);
    let requestUrl = url.toString();
    const init: RequestInit = { method: endpoint.method };
    if (endpoint.method === "POST") {
      init.headers = { "Content-Type": "application/x-www-form-urlencoded" };
      init.body = new URLSearchParams({ q: joined }).toString();
    } else {
      // Legacy GET contract for custom endpoints: the text rides in the URL.
      requestUrl = `${requestUrl}${url.search ? "&" : "?"}q=${encodeURIComponent(joined)}`;
    }
    const res = await fetchWithRetry(requestUrl, init, fetchOpts);
    if (!res.ok) {
      if (res.status === 404 || res.status === 410) {
        throw unavailable(res.status);
      }
      throw new EngineFetchError(
        `Google HTTP ${res.status}`,
        "google",
        "http",
        res.status,
      );
    }
    const json = (await res.json()) as GoogleRpcResponse;
    return parsePrimaryText(json);
  }

  /**
   * Ask the browser API for one translation per text.
   *
   * It takes a list, so segment boundaries survive without any separator
   * trickery — and it is the path that keeps working when the primary one is
   * throttled.
   */
  async function requestBrowserApi(
    texts: string[],
    sl: string,
    tl: string,
  ): Promise<string[]> {
    const res = await fetchWithRetry(
      GOOGLE_BROWSER_API_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json+protobuf",
          "x-goog-api-key": browserApiKey,
        },
        body: JSON.stringify([[texts, sl, tl], "te_lib"]),
      },
      fetchOpts,
    );
    if (!res.ok) {
      if (res.status === 404 || res.status === 410) {
        throw unavailable(res.status);
      }
      throw new EngineFetchError(
        `Google browser API HTTP ${res.status}`,
        "google",
        "http",
        res.status,
      );
    }
    const json = (await res.json()) as GoogleRpcResponse;
    const rows = parseBrowserApiTexts(json);
    if (rows.length !== texts.length) {
      throw new TranslationError(
        `Google browser API returned ${rows.length} results for ${texts.length} texts`,
        "google",
      );
    }
    return rows;
  }

  /**
   * Translate a batch of texts, one translation per text.
   *
   * Primary path first, browser API as the fallback. Empty texts are passed
   * through untouched and are not sent upstream.
   */
  async function translateBatch(
    texts: string[],
    sl: string,
    tl: string,
  ): Promise<string[]> {
    const live = texts
      .map((text, index) => ({ text, index }))
      .filter((entry) => !isEmptyText(entry.text));
    const liveTexts = live.map((entry) => entry.text);
    if (liveTexts.length === 0) return texts.slice();

    const restore = (rows: string[]): string[] => {
      const out = texts.slice();
      live.forEach((entry, i) => {
        out[entry.index] = rows[i] ?? "";
      });
      return out;
    };

    if (browserApiPreferred) {
      try {
        return restore(await requestBrowserApi(liveTexts, sl, tl));
      } catch (err) {
        if (isCancellation(err)) throw err;
        // The fallback is down too; fall back to the primary path below.
        browserApiPreferred = false;
      }
    }

    try {
      const joined = liveTexts.join(SEGMENT_SEPARATOR);
      const text = await requestPrimary(joined, sl, tl);
      const parts = text.split(SEGMENT_SEPARATOR);
      if (parts.length !== liveTexts.length) {
        throw new TranslationError(
          `Google returned ${parts.length} segments for ${liveTexts.length} texts`,
          "google",
        );
      }
      return restore(parts);
    } catch (err) {
      if (isCancellation(err)) throw err;
      try {
        const rows = await requestBrowserApi(liveTexts, sl, tl);
        browserApiPreferred = true;
        return restore(rows);
      } catch {
        // Both paths failed: report the primary failure, which is the one the
        // user actually hit first.
        throw err;
      }
    }
  }

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
      const out: TranslatedSegment[] = new Array(segments.length);
      const sl = pair.source === "auto" ? "auto" : pair.source;
      const tl = pair.target;
      for (let i = 0; i < segments.length; ) {
        // Batch by source size: the primary path is a POST, so the old URL
        // length limit is gone, but a modest request still answers faster.
        let chars = 0;
        let count = 0;
        while (i + count < segments.length) {
          const next = segments[i + count].text.length;
          if (count > 0 && chars + next > MAX_BATCH_CHARS) break;
          chars += next;
          count++;
        }
        const batch = segments.slice(i, i + count);
        const texts = batch.map((s) => s.text);
        let rows: string[];
        try {
          rows = await translateBatch(texts, sl, tl);
        } catch (err) {
          if (err instanceof TranslationError) throw err;
          throw new TranslationError(
            `Google network error: ${(err as Error).message}`,
            "google",
            err,
          );
        }
        if (
          rows.join("").trim().length === 0 &&
          batch.some((s) => !isEmptyText(s.text))
        ) {
          throw new TranslationError(
            "Google returned an empty translation response",
            "google",
          );
        }
        for (let j = 0; j < batch.length; j++) {
          const seg = batch[j];
          const src = seg.text;
          out[i + j] = isEmptyText(src)
            ? { id: seg.id, text: src }
            : { id: seg.id, text: rows[j] ?? "" };
        }
        i += count;
      }
      return { segments: out };
    },
  };
}

/**
 * Probe the free endpoint ahead of the first real request.
 *
 * Its state (alive, rate-limited, or gone) is only knowable by asking it.
 * Doing that in the background means the first translation of the session
 * starts with the answer already in hand, and the TLS connection is warm.
 *
 * Never throws: a failed probe just means the next request learns the state
 * itself.
 */
export async function warmUpGoogleEngine(
  opts: GoogleEngineOptions = {},
): Promise<void> {
  try {
    const eng = createGoogleEngine(opts);
    await eng.translate({
      pair: { source: "auto", target: "en" },
      segments: [{ id: "warmup", text: "a" }],
    });
  } catch {
    // The probe is best-effort; the failure mode is handled by the real call.
  }
}

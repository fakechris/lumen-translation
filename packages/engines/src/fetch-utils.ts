import { TranslationError } from "@lumen/core";

/**
 * Engine fetch helpers: timeout, abort, and bounded retry with exponential
 * backoff for transient HTTP failures (429 / 503).
 *
 * These helpers are shared by every engine adapter so that all remote calls
 * go through one code path with consistent failure semantics.
 */

/** Default request timeout (30 s) for both streaming and non-streaming calls. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum retry attempts for retryable HTTP status codes. */
export const MAX_RETRIES = 3;

/** Base backoff delay (500 ms); multiplied by 2^attempt with jitter. */
export const RETRY_BASE_MS = 500;

/** HTTP status codes that trigger an automatic retry. */
export const RETRYABLE_STATUSES = new Set<number>([429, 503]);

/** Cap for a single Retry-After wait so a hostile server can't stall us. */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * A typed engine-fetch error. `kind` lets callers distinguish timeout / abort
 * / HTTP / network failures without string-matching the message.
 */
export class EngineFetchError extends TranslationError {
  constructor(
    message: string,
    engineId: string,
    public readonly kind: "timeout" | "aborted" | "http" | "network",
    public readonly status?: number,
    cause?: unknown,
  ) {
    super(message, engineId, cause);
    this.name = "EngineFetchError";
  }
}

export interface EngineFetchOptions {
  /** Engine id used to tag thrown errors. */
  engineId: string;
  /** Request timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Max retries for 429/503 (default {@link MAX_RETRIES}). */
  maxRetries?: number;
  /** Base backoff in ms (default {@link RETRY_BASE_MS}). */
  retryBaseMs?: number;
  /** Optional external abort signal (e.g. caller cancellation). */
  abortSignal?: AbortSignal;
}

/**
 * Compose the caller's abort signal with an internal timeout signal. Returns
 * the combined signal and a cleanup function that clears the timer.
 */
function composeSignals(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (timeoutMs <= 0) return { signal: external, cleanup: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", () => controller.abort(external.reason), {
      once: true,
    });
  }
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

/** Sleep with jitter, aborted early if `signal` fires. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      },
      { once: true },
    );
  });
}

/** Parse a Retry-After header (seconds or HTTP-date). Returns ms or undefined. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.min(dateMs - Date.now(), MAX_RETRY_AFTER_MS));
  }
  return undefined;
}

/**
 * Fetch with timeout, abort, and bounded retry on 429/503. Honors the
 * `Retry-After` header when present.
 *
 * Contract:
 * - Timeout / abort / network failures throw {@link EngineFetchError}.
 * - Retryable HTTP statuses (429 / 503) are retried with exponential backoff;
 *   if retries are exhausted the final response is returned to the caller so
 *   it can surface a provider-specific error body.
 * - Non-retryable HTTP statuses (e.g. 400, 401, 404, 500) are returned
 *   unchanged; the caller is responsible for throwing on `!res.ok` and
 *   extracting any error body.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: EngineFetchOptions,
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const retryBaseMs = opts.retryBaseMs ?? RETRY_BASE_MS;
  const engineId = opts.engineId;

  let attempt = 0;
  for (;;) {
    const { signal, cleanup } = composeSignals(opts.abortSignal, timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal });
    } catch (err) {
      cleanup();
      const aborted = signal?.aborted;
      if (aborted) {
        const reason = signal?.reason;
        const isTimeout = reason instanceof Error && reason.message === "timeout";
        throw new EngineFetchError(
          isTimeout ? `Request timed out after ${timeoutMs}ms` : "Request aborted",
          engineId,
          isTimeout ? "timeout" : "aborted",
          undefined,
          err,
        );
      }
      if (attempt < maxRetries) {
        const backoff = retryBaseMs * 2 ** attempt + Math.random() * retryBaseMs;
        await delay(backoff, opts.abortSignal).catch(() => undefined);
        attempt++;
        continue;
      }
      throw new EngineFetchError(
        `Network error: ${(err as Error).message}`,
        engineId,
        "network",
        undefined,
        err,
      );
    }
    cleanup();

    if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
      const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
      const backoff =
        retryAfter ?? retryBaseMs * 2 ** attempt + Math.random() * retryBaseMs;
      // Free the response body before retrying to avoid leaking sockets.
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      try {
        await delay(backoff, opts.abortSignal);
      } catch (err) {
        throw new EngineFetchError(
          "Request aborted during retry backoff",
          engineId,
          "aborted",
          undefined,
          err,
        );
      }
      attempt++;
      continue;
    }

    return res;
  }
}

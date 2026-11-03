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

/**
 * Total time one engine may spend on retries before the caller gives up on it
 * and moves to the next engine (1.5 s by default).
 *
 * A hotkey that waits 20 s for a rate-limited engine to give up is worse than
 * one that tries the next engine after a second and a half. The budget is
 * wall-clock for the whole engine call, so a slow response counts against it
 * too.
 */
export const RETRY_BUDGET_MS = 1500;

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
    public readonly kind: "timeout" | "aborted" | "http" | "network" | "unavailable",
    public readonly status?: number,
    cause?: unknown,
  ) {
    super(message, engineId, cause);
    this.name = "EngineFetchError";
  }
}

/**
 * True when the failure means "this engine cannot work at all", not "this
 * request failed".
 *
 * Such a failure should not be retried, should not be retried by the fallback
 * chain either, and must not leak a raw HTTP status into user-facing text —
 * the user can do nothing about a dead upstream endpoint.
 */
export function isEngineUnavailable(err: unknown): boolean {
  return err instanceof EngineFetchError && err.kind === "unavailable";
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
  /**
   * Wall-clock budget for this engine's retries (default
   * {@link RETRY_BUDGET_MS}). Once it is spent the response is handed back
   * to the caller so the fallback chain can move on.
   */
  retryBudgetMs?: number;
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
  if (timeoutMs <= 0) {
    return { signal: external, cleanup: () => {} };
  }
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
 * True when another attempt still fits in the engine's retry budget.
 *
 * The budget is wall-clock: it covers the requests already made *and* the
 * wait before the next one, so a slow response eats into it.
 */
function withinBudget(
  budgetMs: number,
  startedAt: number,
  waitMs: number,
): boolean {
  if (budgetMs <= 0) return false;
  return Date.now() - startedAt + waitMs <= budgetMs;
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
 * - **A 429 without a `Retry-After` header is not retried.** The server is
 *   rate-limiting this client and won't say when to come back; retrying only
 *   burns the engine's budget, while the next engine in the fallback chain
 *   would answer right away. The response is handed back so the caller can
 *   move on.
 * - Retries also stop once the engine's retry budget
 *   ({@link EngineFetchOptions.retryBudgetMs}) is spent, for the same reason.
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
  const retryBudgetMs = opts.retryBudgetMs ?? RETRY_BUDGET_MS;
  const engineId = opts.engineId;
  const startedAt = Date.now();

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
        if (!withinBudget(retryBudgetMs, startedAt, backoff)) {
          throw new EngineFetchError(
            `Network error: ${(err as Error).message}`,
            engineId,
            "network",
            undefined,
            err,
          );
        }
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
      // Rate-limited without a "come back at" hint: the server is throttling
      // this client, and the next engine answers sooner than a retry would.
      if (res.status === 429 && retryAfter === undefined) {
        return res;
      }
      const backoff =
        retryAfter ?? retryBaseMs * 2 ** attempt + Math.random() * retryBaseMs;
      // The engine's budget is spent: hand the response back so the caller
      // can fall over to the next engine instead of waiting longer here.
      if (!withinBudget(retryBudgetMs, startedAt, backoff)) {
        return res;
      }
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

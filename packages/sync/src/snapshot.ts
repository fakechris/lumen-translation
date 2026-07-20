import type { Settings } from "@lumen/core";

/**
 * Secret handling for settings snapshots.
 *
 * Snapshots are serialized and pushed to a remote backend (WebDAV file or the
 * self-hosted worker's KV store). Settings carry plaintext credentials —
 * per-engine `apiKey`s and the sync backend's own `webdavPass` / `workerToken`
 * (stored under `settings.engines.__sync__`). Uploading those verbatim would
 * leak long-lived secrets to whatever hosts the remote store.
 *
 * `redactSecrets` strips every secret-looking key before upload; `restoreSecrets`
 * re-applies the local device's secrets after pulling a (redacted) remote copy,
 * so a merge never overwrites a live local credential with a missing/empty
 * remote value.
 */

const SECRET_KEY_PATTERN = /(apikey|token|secret|password|webdavpass|workertoken)/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepRedact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepRedact);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (isSecretKey(key)) continue; // never serialize secret fields remotely
      out[key] = deepRedact(val);
    }
    return out;
  }
  return value;
}

/** Deep clone of `settings` with all secret-looking fields removed. */
export function redactSecrets(settings: Settings): Settings {
  return deepRedact(settings) as Settings;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function deepRestore(target: unknown, source: unknown): unknown {
  if (!isPlainObject(source)) return target;
  const base: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, srcVal] of Object.entries(source)) {
    if (isSecretKey(key)) {
      // Keep a non-empty remote secret if present; otherwise fall back to local.
      if (isEmpty(base[key])) base[key] = srcVal;
    } else if (isPlainObject(srcVal)) {
      base[key] = deepRestore(base[key], srcVal);
    }
    // Non-secret primitives/arrays keep whatever `target` already decided.
  }
  return base;
}

/**
 * Returns a copy of `target` with secret fields from `source` (the local
 * device) re-applied wherever `target` lacks a non-empty value.
 */
export function restoreSecrets(target: Settings, source: Settings): Settings {
  return deepRestore(target, source) as Settings;
}

import type { Settings } from "@lumen/core";
import type { SyncBackend, SyncSnapshot } from "./types.js";
import { mergeSettings } from "./merge.js";
import { redactSecrets, restoreSecrets } from "./snapshot.js";

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }

  return true;
}

export async function syncOnce(
  backend: SyncBackend,
  local: Settings,
  opts: {
    strategy?: "local-wins" | "remote-wins" | "merge-rules";
    device?: string;
  } = {},
): Promise<{ before: Settings; after: Settings; direction: "pulled" | "pushed" | "merged" | "noop" }> {
  const remote = await backend.pull();

  if (remote === null) {
    // Never upload plaintext credentials; the remote copy is redacted.
    const snapshot: SyncSnapshot = {
      version: 1,
      settings: redactSecrets(local),
      updatedAt: new Date().toISOString(),
      device: opts.device,
    };
    await backend.push(snapshot);
    return { before: local, after: local, direction: "pushed" };
  }

  // The remote snapshot is redacted, so reinstate this device's secrets before
  // comparing/merging — otherwise stripped fields would look like a diff and a
  // remote-wins merge would wipe our local credentials.
  const remoteSettings = restoreSecrets(remote.settings, local);

  if (deepEqual(local, remoteSettings)) {
    return { before: local, after: local, direction: "noop" };
  }

  const strategy = opts.strategy ?? "merge-rules";
  const merged = restoreSecrets(mergeSettings(local, remoteSettings, strategy), local);

  const snapshot: SyncSnapshot = {
    version: 1,
    settings: redactSecrets(merged),
    updatedAt: new Date().toISOString(),
    device: opts.device,
  };
  await backend.push(snapshot);

  const direction: "pulled" | "pushed" | "merged" =
    strategy === "local-wins" ? "pushed" : strategy === "remote-wins" ? "pulled" : "merged";

  return { before: local, after: merged, direction };
}

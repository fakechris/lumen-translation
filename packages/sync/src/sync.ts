import type { Settings } from "@lumen/core";
import type { SyncBackend, SyncSnapshot } from "./types.js";
import { mergeSettings } from "./merge.js";

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
    const snapshot: SyncSnapshot = {
      version: 1,
      settings: local,
      updatedAt: new Date().toISOString(),
      device: opts.device,
    };
    await backend.push(snapshot);
    return { before: local, after: local, direction: "pushed" };
  }

  if (deepEqual(local, remote.settings)) {
    return { before: local, after: local, direction: "noop" };
  }

  const strategy = opts.strategy ?? "merge-rules";
  const merged = mergeSettings(local, remote.settings, strategy);

  const snapshot: SyncSnapshot = {
    version: 1,
    settings: merged,
    updatedAt: new Date().toISOString(),
    device: opts.device,
  };
  await backend.push(snapshot);

  const direction: "pulled" | "pushed" | "merged" =
    strategy === "local-wins" ? "pushed" : strategy === "remote-wins" ? "pulled" : "merged";

  return { before: local, after: merged, direction };
}

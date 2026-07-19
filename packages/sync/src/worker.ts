import type { SyncBackend, SyncSnapshot } from "./types.js";

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function createWorkerBackend(opts: {
  url: string;
  token: string;
  deviceId?: string;
}): SyncBackend {
  const base = trimTrailingSlash(opts.url);
  const authHeader = `Bearer ${opts.token}`;
  const headers = { Authorization: authHeader };

  return {
    id: "worker",
    async pull(): Promise<SyncSnapshot | null> {
      const res = await fetch(`${base}/snapshot`, { method: "GET", headers });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`Worker pull failed: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as SyncSnapshot;
    },
    async push(snapshot: SyncSnapshot): Promise<void> {
      const res = await fetch(`${base}/snapshot`, {
        method: "PUT",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(snapshot),
      });
      if (!res.ok) {
        throw new Error(`Worker push failed: ${res.status} ${res.statusText}`);
      }
    },
    async test(): Promise<string | null> {
      try {
        const res = await fetch(`${base}/health`, { method: "GET", headers });
        return res.ok ? null : `${res.status} ${res.statusText}`;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
  };
}

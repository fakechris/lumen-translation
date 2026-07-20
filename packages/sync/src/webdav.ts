import type { SyncBackend, SyncSnapshot } from "./types.js";
import { validateRemoteUrl } from "./url-guard.js";

function buildFileUrl(url: string, path?: string): string {
  const base = url.replace(/\/+$/, "");
  const filePath = path ?? "/lumen-settings.json";
  const normalized = filePath.startsWith("/") ? filePath : `/${filePath}`;
  return `${base}${normalized}`;
}

function basicAuth(username: string, password: string): string {
  const credentials = `${username}:${password}`;
  if (typeof btoa === "function") {
    return `Basic ${btoa(credentials)}`;
  }
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

export function createWebDavBackend(opts: {
  url: string;
  username: string;
  password: string;
  path?: string;
}): SyncBackend {
  // SSRF guard: refuse loopback/private/link-local targets before any fetch.
  const urlError = validateRemoteUrl(opts.url);
  const fileUrl = buildFileUrl(opts.url, opts.path);
  const authHeader = basicAuth(opts.username, opts.password);
  const headers = { Authorization: authHeader };

  return {
    id: "webdav",
    async pull(): Promise<SyncSnapshot | null> {
      if (urlError) throw new Error(urlError);
      const res = await fetch(fileUrl, { method: "GET", headers });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`WebDAV pull failed: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as SyncSnapshot;
    },
    async push(snapshot: SyncSnapshot): Promise<void> {
      if (urlError) throw new Error(urlError);
      const res = await fetch(fileUrl, {
        method: "PUT",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(snapshot, null, 2),
      });
      if (!res.ok) {
        throw new Error(`WebDAV push failed: ${res.status} ${res.statusText}`);
      }
    },
    async test(): Promise<string | null> {
      if (urlError) return urlError;
      try {
        const res = await fetch(fileUrl, { method: "OPTIONS", headers });
        return res.ok ? null : `${res.status} ${res.statusText}`;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
  };
}

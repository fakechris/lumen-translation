/**
 * Route `fetch` through Tauri's HTTP plugin.
 *
 * The webview runs on the `tauri://` / `http://tauri.localhost` origin, so a
 * plain `fetch` to translate.googleapis.com or api.openai.com is blocked by
 * CORS — none of those endpoints send `Access-Control-Allow-Origin` for us.
 * The plugin performs the request in Rust (no CORS, no preflight) and returns
 * a standard `Response`, so `@lumen/engines` keeps working unmodified.
 *
 * Import this for its side effect *before* any engine code runs.
 */

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

declare global {
  interface Window {
    __lumenFetchBridged?: boolean;
  }
}

if (!window.__lumenFetchBridged) {
  const browserFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    // Vite's dev server, HMR, and our own bundled assets are same-origin and
    // must not take the Rust detour (the plugin can't see the dev server's
    // in-memory modules).
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith("/") || url.startsWith(window.location.origin)) {
      return browserFetch(input as RequestInfo, init);
    }
    return tauriFetch(input as string | URL, init);
  }) as typeof window.fetch;
  window.__lumenFetchBridged = true;
}

export {};

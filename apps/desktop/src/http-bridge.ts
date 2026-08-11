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

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

declare global {
  interface Window {
    __lumenFetchBridged?: boolean;
  }
}

export function shouldUseBrowserFetch(url: string, pageHref: string): boolean {
  const resolved = new URL(url, pageHref);
  const page = new URL(pageHref);
  const tauriInternal =
    resolved.protocol === 'ipc:' ||
    resolved.protocol === 'tauri:' ||
    resolved.protocol === 'asset:' ||
    resolved.hostname === 'ipc.localhost' ||
    resolved.hostname === 'tauri.localhost' ||
    resolved.hostname === 'asset.localhost';
  return resolved.origin === page.origin || tauriInternal;
}

if (typeof window !== 'undefined' && !window.__lumenFetchBridged) {
  const browserFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    // Vite's dev server, HMR, and our own bundled assets are same-origin and
    // must not take the Rust detour (the plugin can't see the dev server's
    // in-memory modules). Tauri's IPC implementation also uses internal
    // protocols/hosts; routing those back through the HTTP plugin would
    // recurse invoke -> fetch -> invoke until WebView2 terminates the renderer.
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (shouldUseBrowserFetch(url, window.location.href)) {
      return browserFetch(input as RequestInfo, init);
    }
    return tauriFetch(input as string | URL, init);
  }) as typeof window.fetch;
  window.__lumenFetchBridged = true;
}

export {};

// PopClip's JavaScript environment is JavaScriptCore and ships only XHR and
// axios for networking — no `fetch`. Our @lumen/engines use `fetch`, so we
// install a small fetch-on-XHR polyfill before invoking any engine. This runs
// as the first statement of the bundled script.
export function installFetchPolyfill(): void {
  if (typeof globalThis.fetch === "function") return;

  type HeadersInit = Record<string, string>;

  // Loosen the signature so it's compatible with the DOM `fetch` type while
  // only accepting the string URLs + simple init that our engines emit.
  const impl = async (
    input: RequestInfo | URL,
    init?: { method?: string; headers?: HeadersInit; body?: string },
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const xhr = new XMLHttpRequest();
    xhr.open(init?.method ?? "GET", url, true);
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers)) {
        try {
          xhr.setRequestHeader(k, String(v));
        } catch {
          // some headers are forbidden by XHR; ignore
        }
      }
    }
    return await new Promise<Response>((resolve, reject) => {
      xhr.onload = () => {
        const headerMap = new Map<string, string>();
        xhr.getAllResponseHeaders()
          .split(/\r?\n/)
          .forEach((line) => {
            const i = line.indexOf(":");
            if (i > 0) headerMap.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
          });
        const response = {
          ok: xhr.status >= 200 && xhr.status < 300,
          status: xhr.status,
          statusText: xhr.statusText,
          text: () => Promise.resolve(xhr.responseText),
          json: () => Promise.resolve(JSON.parse(xhr.responseText)),
          headers: { get: (n: string) => headerMap.get(n.toLowerCase()) ?? null },
        } as unknown as Response;
        resolve(response);
      };
      xhr.onerror = () => reject(new Error(`network error: ${xhr.status}`));
      xhr.send(init?.body);
    });
  };

  (globalThis as { fetch?: typeof fetch }).fetch = impl as typeof fetch;
}

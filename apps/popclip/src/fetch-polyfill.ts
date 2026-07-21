// PopClip's JavaScript environment is JavaScriptCore and ships no `fetch` and
// no first-class `XMLHttpRequest`. The supported HTTP client is the bundled
// `axios` module (`require("axios")`). Our @lumen/engines use `fetch`, so we
// install a small fetch-on-axios polyfill before invoking any engine. `axios`
// is marked external in the esbuild build so `require("axios")` is left intact
// for PopClip to resolve at runtime.
declare function require(id: string): unknown;

interface AxiosResponse {
  status: number;
  statusText?: string;
  data: unknown;
  headers?: Record<string, string>;
}
interface AxiosRequestConfig {
  url: string;
  method: string;
  headers?: Record<string, string>;
  data?: unknown;
  responseType?: string;
  transformResponse?: Array<(d: unknown) => unknown>;
  validateStatus?: (status: number) => boolean;
}
type AxiosFn = (config: AxiosRequestConfig) => Promise<AxiosResponse>;

export function installFetchPolyfill(): void {
  if (typeof globalThis.fetch === "function") return;

  // PopClip's bundled axios is exposed as an ES module namespace, so the
  // callable lives on `.default` (matching `import axios from "axios"` →
  // `require("axios").default`). Fall back to the module itself for CJS builds.
  const axiosMod = require("axios") as { default?: AxiosFn } & Partial<AxiosFn>;
  const axios = (axiosMod.default ?? axiosMod) as AxiosFn;

  type HeadersInit = Record<string, string>;

  const impl = async (
    input: RequestInfo | URL,
    init?: { method?: string; headers?: HeadersInit; body?: string },
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const res = await axios({
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: init?.headers,
      data: init?.body,
      responseType: "text",
      // Keep the raw response body as a string; engines parse it themselves.
      transformResponse: [(d) => d],
      // Never throw on non-2xx; engines inspect `ok`/`status`.
      validateStatus: () => true,
    });

    const raw = res.data;
    const bodyText = typeof raw === "string" ? raw : JSON.stringify(raw);
    const headers = res.headers ?? {};

    const response = {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: res.statusText ?? "",
      text: () => Promise.resolve(bodyText),
      json: () =>
        Promise.resolve(
          typeof raw === "string" ? JSON.parse(raw) : raw,
        ),
      headers: {
        get: (n: string) => headers[n.toLowerCase()] ?? headers[n] ?? null,
      },
    } as unknown as Response;
    return response;
  };

  (globalThis as { fetch?: typeof fetch }).fetch = impl as typeof fetch;
}

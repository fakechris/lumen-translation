// Type shims for the Greasemonkey/Tampermonkey APIs available to userscripts.
// At runtime these are injected by the userscript manager.

declare const GM_getValue: <T = unknown>(key: string, def?: T) => T;
declare const GM_setValue: (key: string, value: unknown) => void;
declare const GM_xmlhttpRequest: (details: {
  method?: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  onload?: (res: { status: number; responseText: string }) => void;
  onerror?: (err: unknown) => void;
}) => void;

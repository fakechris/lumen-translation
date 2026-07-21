// Lumen Translation PopClip entry (module style).
//
// PopClip loads this as a CommonJS module (Config.json `"module": "script.js"`)
// and calls the exported `action(input, options)` when the user clicks Lumen.
// The action translates, then opens the LumenWindow companion app via the
// `lumenwindow://` URL scheme so the result renders in a Bob-style floating
// window near the cursor (instead of PopClip's small bar). A fetch-on-axios
// polyfill is installed at module load so the existing @lumen/engines work.

import { translateAll, type Engine, type Segment } from "@lumen/core";
import {
  createGoogleEngine,
  createMicrosoftEngine,
  createProviderEngine,
} from "@lumen/engines";
import { installFetchPolyfill } from "./fetch-polyfill.js";

// PopClip runtime globals — provided by the action context, not the test
// harness. `openUrl` launches a URL via LaunchServices (used to invoke the
// LumenWindow companion app). The official API name is `openUrl` (lowercase
// rl), per https://www.popclip.app/dev/js-environment.
declare const popclip: {
  openUrl?: (url: string) => void;
  openURL?: (url: string) => void;
};

declare const pasteboard: { text: string };

// PopClip provides a global `print()` for debug output (visible in Console.app
// when EnableExtensionDebug is on, and in the `PopClip run` test harness).
declare function print(s: string): void;

installFetchPolyfill();

interface PopclipInput {
  text: string;
}

interface PopclipOptions {
  targetLang?: string;
  sourceLang?: string;
  engine?: string;
  apiKey?: string;
  model?: string;
  showSource?: boolean;
}

function buildEngine(opts: PopclipOptions): Engine {
  switch (opts.engine) {
    case "microsoft":
      return createMicrosoftEngine();
    case "google":
      return createGoogleEngine();
    default: {
      if (!opts.apiKey) {
        throw new Error("this engine needs an API Key. Open Lumen settings and paste your key.");
      }
      const engine = createProviderEngine(opts.engine ?? "google", {
        apiKey: opts.apiKey,
        model: opts.model || undefined,
      });
      if (!engine) {
        throw new Error(`unknown engine "${opts.engine}".`);
      }
      return engine;
    }
  }
}

// Small base64 encoder for URL payload (UTF-8 safe). PopClip's JSC has btoa,
// but it operates on Latin-1 only; encode UTF-8 bytes first.
function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function openWindow(payload: {
  source: string;
  translation: string;
  engine: string;
  sourceLang: string;
  targetLang: string;
}): { ok: boolean; method: string; urlLen: number; err?: string } {
  const json = JSON.stringify(payload);
  const url = `lumen-popclip-9j3kx1://show?d=${base64Utf8(json)}`;
  // Per PopClip docs the canonical name is `openUrl` (lowercase rl).
  // Fall back to `openURL` defensively in case of undocumented aliasing.
  try {
    if (typeof popclip.openUrl === "function") {
      popclip.openUrl(url);
      return { ok: true, method: "popclip.openUrl", urlLen: url.length };
    }
    if (typeof popclip.openURL === "function") {
      popclip.openURL(url);
      return { ok: true, method: "popclip.openURL", urlLen: url.length };
    }
    return {
      ok: false,
      method: "none",
      urlLen: url.length,
      err: `openUrl=${typeof popclip.openUrl}, openURL=${typeof popclip.openURL}, keys=${Object.keys(popclip).join(",")}`,
    };
  } catch (e) {
    return { ok: false, method: "throw", urlLen: url.length, err: (e as Error)?.message ?? String(e) };
  }
}

export const action = async (
  input: PopclipInput,
  options: PopclipOptions,
): Promise<string> => {
  try {
    print("[lumen] action start");
    const opts = options ?? {};
    const text = (input?.text ?? "").trim();
    if (!text) {
      print("[lumen] no text selected");
      return "Lumen: no text selected";
    }
    print(`[lumen] text len=${text.length} engine=${opts.engine} target=${opts.targetLang}`);

    const engine = buildEngine(opts);
    const pair = {
      source: opts.sourceLang || "auto",
      target: opts.targetLang || "zh-CN",
    };
    const segments: Segment[] = [{ id: "s1", text }];

    const result = await translateAll(engine, { pair, segments });
    const translated = (result.segments[0]?.text ?? "").trim();
    print(`[lumen] translateAll done, len=${translated.length}`);
    if (!translated) return text;

    const wres = openWindow({
      source: text,
      translation: translated,
      engine: opts.engine ?? "google",
      sourceLang: pair.source,
      targetLang: pair.target,
    });
    print(`[lumen] openWindow ${JSON.stringify(wres)}`);
    // DIAGNOSTIC: also stash on clipboard for easy copy/paste. Remove.
    try {
      pasteboard.text = "LUMEN-WIN-DIAG: " + JSON.stringify(wres);
    } catch {
      // ignore
    }
    return "";
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    print(`[lumen] ERROR ${msg}`);
    return "Lumen error: " + msg;
  }
};


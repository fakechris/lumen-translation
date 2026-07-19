// Lumen Translation PopClip entry.
//
// Behaviour:
//   - Reads the selected text from popclip.input.text
//   - Translates via the configured engine (Google / Microsoft / OpenAI-compat)
//   - Returns the translated string; PopClip's `after` setting decides whether
//     to show it in the bar, copy it, or paste it (see Config.json).
//
// The script is bundled with esbuild into a single IIFE script.js that runs in
// PopClip's JavaScriptCore sandbox. A fetch-on-XHR polyfill is installed first
// so the existing @lumen/engines work unchanged.

import { translateAll, type Engine, type Segment } from "@lumen/core";
import {
  createGoogleEngine,
  createMicrosoftEngine,
  createOpenAIEngine,
  createProviderEngine,
} from "@lumen/engines";
import { installFetchPolyfill } from "./fetch-polyfill.js";

installFetchPolyfill();

interface PopclipOptions {
  targetLang?: string;
  sourceLang?: string;
  engine?: string;
  apiKey?: string;
  endpoint?: string;
  model?: string;
  showSource?: boolean;
}

function buildEngine(opts: PopclipOptions): Engine {
  switch (opts.engine) {
    case "microsoft":
      return createMicrosoftEngine();
    case "openai":
      return createOpenAIEngine({
        apiKey: opts.apiKey || undefined,
        endpoint: opts.endpoint || undefined,
        model: opts.model || undefined,
      });
    case "google":
      return createGoogleEngine();
    default: {
      // Built-in provider presets: deepseek, glm, kimi, qwen, doubao, minimax, ...
      const engine = createProviderEngine(opts.engine ?? "google", {
        apiKey: opts.apiKey,
        model: opts.model,
      });
      return engine ?? createGoogleEngine();
    }
  }
}

async function main(): Promise<string> {
  const opts: PopclipOptions = (popclip.options ?? {}) as PopclipOptions;
  const text = (popclip.input?.text ?? "").trim();
  if (!text) {
    popclip.showFailure?.("No text selected");
    return "";
  }

  const engine = buildEngine(opts);
  const pair = {
    source: opts.sourceLang || "auto",
    target: opts.targetLang || "zh",
  };
  const segments: Segment[] = [{ id: "s1", text }];

  try {
    const result = await translateAll(engine, { pair, segments });
    const translated = result.segments[0]?.text ?? text;
    if (opts.showSource) {
      return `${text}\n\n——\n\n${translated}`;
    }
    return translated;
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    popclip.showFailure?.(`Lumen: ${message}`);
    return `Lumen error: ${message}`;
  }
}

// PopClip awaits the top-level return value of the script.
void main().then((out) => {
  if (out) popclip.showText?.(out);
});

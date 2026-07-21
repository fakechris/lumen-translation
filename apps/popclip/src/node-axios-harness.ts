// Node harness that exercises the ACTUAL axios-based fetch polyfill against
// real network. Node has native fetch (which PopClip lacks), so we delete it
// first to force installFetchPolyfill down the axios path — the same code that
// runs in PopClip. Bundled as CJS/node so require("axios") resolves the real
// installed module.
import { translateAll } from "@lumen/core";
import { createGoogleEngine } from "@lumen/engines";
import { installFetchPolyfill } from "./fetch-polyfill.js";

delete (globalThis as { fetch?: unknown }).fetch;

installFetchPolyfill();

async function run(): Promise<void> {
  console.log("fetch after polyfill:", typeof globalThis.fetch);
  const eng = createGoogleEngine();
  const result = await translateAll(eng, {
    pair: { source: "auto", target: "zh-CN" },
    segments: [{ id: "s1", text: "The quick brown fox jumps over the lazy dog." }],
  });
  console.log("RESULT:", JSON.stringify(result.segments[0]?.text));
}

run().catch((e) => {
  console.error("ERROR:", (e && e.message) || String(e));
  console.error(e && e.stack);
  (globalThis as { process?: { exitCode?: number } }).process!.exitCode = 1;
});

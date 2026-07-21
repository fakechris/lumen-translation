// Test entry: runs the real translation pipeline (fetch->XHR polyfill) in the
// ACTUAL PopClip JS environment via the CLI test harness:
//   /Applications/PopClip.app/Contents/MacOS/PopClip run dist/popclip-test.js
// Uses print() (PopClip's debug output) since console.log is unavailable.
import { translateAll } from "@lumen/core";
import { createGoogleEngine } from "@lumen/engines";
import { installFetchPolyfill } from "./fetch-polyfill.js";

installFetchPolyfill();

async function run(): Promise<string> {
  print("lumen-test: polyfill installed, fetch=" + typeof globalThis.fetch);
  const eng = createGoogleEngine();
  print("lumen-test: engine built, starting translate");
  const result = await translateAll(eng, {
    pair: { source: "auto", target: "zh-CN" },
    segments: [{ id: "s1", text: "The quick brown fox jumps over the lazy dog." }],
  });
  const out = result.segments[0]?.text ?? "(empty)";
  print("lumen-test: result=" + out);
  return out;
}

run().catch((err) => {
  print("lumen-test: ERROR " + ((err && err.message) || String(err)));
  throw err;
});

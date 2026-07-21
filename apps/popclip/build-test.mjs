// Bundle the PopClip harness entry (src/lumen.popclip.harness.ts) with the SAME
// esbuild config + AbortController banner as the production build, then run:
//   /Applications/PopClip.app/Contents/MacOS/PopClip run dist/popclip-test.js
import { build } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ABORT_CONTROLLER_BANNER } from "./banner.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(__dirname, "src/lumen.popclip.harness.ts")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: false,
  legalComments: "none",
  banner: { js: ABORT_CONTROLLER_BANNER },
  external: ["axios"],
  outfile: resolve(__dirname, "dist/popclip-test.js"),
  logLevel: "warning",
  tsconfig: resolve(__dirname, "tsconfig.json"),
});
console.log("wrote dist/popclip-test.js");

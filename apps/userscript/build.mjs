// Build the Lumen userscript: bundle src/lumen.user.ts with esbuild and
// prepend the ==UserScript== metadata header.
import { context } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

const HEADER = `// ==UserScript==
// @name         Lumen Translation
// @namespace    https://github.com/lumen-translation/lumen
// @version      0.1.0
// @description  Open-source bilingual web translation (Apache-2.0). Alt+Q toggle, Alt+S selection.
// @author       Lumen Translation Contributors
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      translate.googleapis.com
// @connect      *
// @run-at       document-idle
// @license      Apache-2.0
// ==/UserScript==
`;

const watching = process.argv.includes("--watch");

async function writeBundle(result) {
  const out = (Array.isArray(result) ? result[0] : result);
  const code = "output" in out ? String(out.output) : "";
  const dist = resolve(__dirname, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(resolve(dist, "lumen.user.js"), `${HEADER}\n${code}`);
  writeFileSync(resolve(ROOT, "lumen.user.js"), `${HEADER}\n${code}`);
  console.log("wrote dist/lumen.user.js and lumen.user.js");
}

async function main() {
  const ctx = await context({
    entryPoints: [resolve(__dirname, "src/lumen.user.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    sourcemap: false,
    logLevel: "info",
    tsconfig: resolve(__dirname, "tsconfig.json"),
  });
  if (watching) {
    await ctx.watch();
    console.log("watching for changes...");
  } else {
    const result = await ctx.rebuild();
    await writeBundle(result);
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

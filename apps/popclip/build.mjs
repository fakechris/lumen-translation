// Build the Lumen PopClip extension package.
//
//   1. Bundle src/lumen.popclip.ts with esbuild (IIFE, browser platform, ES2020)
//   2. Assemble dist/Lumen.popclipext/ with Config.json, script.js, icon.png
//   3. Optionally zip to dist/Lumen.popclipextz for distribution
import { context } from "esbuild";
import { copyFileSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const OUT = resolve(__dirname, "dist");
const PKG = resolve(OUT, "Lumen.popclipext");
const watching = process.argv.includes("--watch");
const zip = process.argv.includes("--zip");

async function writeBundle(result) {
  const files = result?.outputFiles ?? [];
  const out = files.find((f) => f.path.endsWith("script.js")) ?? files[0];
  const code = out?.text ?? "";
  writeFileSync(resolve(PKG, "script.js"), code);
  copyFileSync(resolve(__dirname, "Config.json"), resolve(PKG, "Config.json"));
  // Reuse the extension's 128px icon as the PopClip icon.
  copyFileSync(resolve(ROOT, "apps/extension/public/icon/128.png"), resolve(PKG, "icon.png"));
  console.log(`wrote ${PKG} (script.js ${code.length} bytes)`);
  if (zip) {
    try {
      execSync(`cd "${OUT}" && zip -r -X Lumen.popclipextz Lumen.popclipext`, { stdio: "inherit" });
      console.log(`wrote ${resolve(OUT, "Lumen.popclipextz")}`);
    } catch (err) {
      console.warn("zip step skipped (zip CLI unavailable):", err && err.message);
    }
  }
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(PKG, { recursive: true });

  const ctx = await context({
    entryPoints: [resolve(__dirname, "src/lumen.popclip.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    write: false,
    sourcemap: false,
    logLevel: "info",
    legalComments: "none",
    // Keep node built-ins out of the bundle (PopClip provides its own).
    external: [],
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

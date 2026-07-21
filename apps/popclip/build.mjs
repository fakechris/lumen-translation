// Build the Lumen PopClip extension package.
// Pure AppleScript action — delegates translation to LumenWindow companion.
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const OUT = resolve(__dirname, "dist");
const PKG = resolve(OUT, "Lumen.popclipext");
const zip = process.argv.includes("--zip");

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(PKG, { recursive: true });
  copyFileSync(resolve(__dirname, "Config.json"), resolve(PKG, "Config.json"));
  copyFileSync(resolve(__dirname, "Lumen.applescript"), resolve(PKG, "Lumen.applescript"));
  copyFileSync(resolve(ROOT, "apps/extension/public/icon/128.png"), resolve(PKG, "icon.png"));
  console.log(`wrote ${PKG}`);
  if (zip) {
    execSync(`cd "${OUT}" && zip -r -X Lumen.popclipextz Lumen.popclipext`, { stdio: "inherit" });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

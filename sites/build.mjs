// Concatenate rules/*.json into a single index.json for easy subscription.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = resolve(__dirname, "rules");
let all = [];
try {
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    all = all.concat(JSON.parse(readFileSync(resolve(dir, f), "utf8")));
  }
} catch {
  // no rules dir yet
}
writeFileSync(resolve(__dirname, "index.json"), JSON.stringify(all, null, 2) + "\n");
console.log(`wrote index.json with ${all.length} rules`);

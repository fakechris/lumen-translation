#!/usr/bin/env node
/**
 * Sync the vendored provider catalog from the canonical lumen-suite contract.
 *
 * The catalog (`lumen.provider-catalog/v1`) is the single source of truth for
 * LLM provider endpoints, default models, auth, and quirks across the Lumen
 * product suite. This repo vendors a byte-for-byte copy at
 * `packages/engines/src/provider-catalog.v1.json`; never hand-edit that file —
 * run this script instead:
 *
 *   node scripts/sync-provider-catalog.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RAW_URL =
  "https://raw.githubusercontent.com/fakechris/lumen-suite/main/contracts/provider-catalog.v1.json";
const DEST = fileURLToPath(
  new URL("../packages/engines/src/provider-catalog.v1.json", import.meta.url),
);
const EXPECTED_SPEC = "lumen.provider-catalog/v1";

const res = await fetch(RAW_URL);
if (!res.ok) {
  console.error(`Failed to fetch catalog: HTTP ${res.status} ${res.statusText} (${RAW_URL})`);
  process.exit(1);
}
const text = await res.text();

let data;
try {
  data = JSON.parse(text);
} catch (err) {
  console.error(`Fetched catalog is not valid JSON: ${err.message}`);
  process.exit(1);
}
if (data.spec !== EXPECTED_SPEC) {
  console.error(
    `Fetched catalog has spec "${data.spec}", expected "${EXPECTED_SPEC}". ` +
      "A new major contract version requires an adapter update, not a blind sync.",
  );
  process.exit(1);
}
if (!Array.isArray(data.providers) || data.providers.length === 0) {
  console.error("Fetched catalog has no providers — refusing to overwrite local copy.");
  process.exit(1);
}

let current = null;
try {
  current = readFileSync(DEST, "utf8");
} catch {
  // First sync: no local copy yet.
}

if (current === text) {
  console.log(`Already up to date (version ${data.version}, ${data.providers.length} providers).`);
} else {
  writeFileSync(DEST, text);
  console.log(
    `Updated ${DEST} to version ${data.version} (${data.providers.length} providers).`,
  );
  console.log("Run `pnpm -r test` to verify the contract tests still pass.");
}

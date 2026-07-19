import { describe, it, expect } from "vitest";
import { DEFAULT_SETTINGS } from "@lumen/core";
import type { Settings } from "@lumen/core";
import { mergeSettings } from "./merge.js";

const local: Settings = {
  ...DEFAULT_SETTINGS,
  targetLang: "zh",
  engines: { openai: { model: "gpt-4" } },
  glossary: [{ source: "hello", target: "你好" }],
  rules: [{ match: "*.local.com", targetLang: "ja" }],
};

const remote: Settings = {
  ...DEFAULT_SETTINGS,
  targetLang: "en",
  engines: { google: { apiKey: "secret" } },
  glossary: [{ source: "world", target: "世界" }],
  rules: [
    { match: "*.local.com", targetLang: "fr" },
    { match: "*.remote.com", bilingual: false },
  ],
};

describe("mergeSettings", () => {
  it("local-wins keeps local settings", () => {
    const merged = mergeSettings(local, remote, "local-wins");
    expect(merged).toBe(local);
  });

  it("remote-wins takes remote settings", () => {
    const merged = mergeSettings(local, remote, "remote-wins");
    expect(merged).toBe(remote);
  });

  it("merge-rules appends remote rules not in local and keeps local engine config and glossary", () => {
    const merged = mergeSettings(local, remote, "merge-rules");

    expect(merged.engines).toBe(local.engines);
    expect(merged.glossary).toBe(local.glossary);
    expect(merged.targetLang).toBe(local.targetLang);
    expect(merged.rules).toHaveLength(2);
    expect(merged.rules[0]).toBe(local.rules[0]);
    expect(merged.rules[1]).toBe(remote.rules[1]);
  });
});

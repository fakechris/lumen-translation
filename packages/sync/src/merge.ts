import type { Settings } from "@lumen/core";

export function mergeSettings(
  local: Settings,
  remote: Settings,
  strategy: "local-wins" | "remote-wins" | "merge-rules",
): Settings {
  if (strategy === "local-wins") return local;
  if (strategy === "remote-wins") return remote;

  const localMatches = new Set(local.rules.map((rule) => rule.match));
  const remoteRules = remote.rules.filter((rule) => !localMatches.has(rule.match));

  return {
    ...local,
    rules: [...local.rules, ...remoteRules],
  };
}

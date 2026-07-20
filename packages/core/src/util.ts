/**
 * @lumen/core — shared pure string utilities used across packages and apps.
 *
 * These helpers are engine-agnostic and DOM-agnostic so they stay in core.
 */

import type { EngineConfig, Settings } from "./types.js";

/** Escape HTML special characters for safe text insertion. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/** Return a typed engine configuration for the given engine id. */
export function getEngineConfig(settings: Settings, id: string): EngineConfig {
  const raw = settings.engines[id];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as EngineConfig;
  }
  return {};
}

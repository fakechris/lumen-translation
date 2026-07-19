import type { Engine } from "@lumen/core";
import { createOpenAIEngine, type OpenAIEngineOptions } from "./openai.js";

/**
 * Ollama engine — uses Ollama's OpenAI-compatible endpoint
 * (http://localhost:11434/v1/chat/completions). No API key required for local
 * use; users must start ollama with OLLAMA_ORIGINS=* for CORS.
 */
export interface OllamaEngineOptions extends Omit<OpenAIEngineOptions, "endpoint" | "apiKey"> {
  baseUrl?: string;
  model?: string;
}

export function createOllamaEngine(opts: OllamaEngineOptions = {}): Engine {
  const baseUrl = opts.baseUrl ?? "http://localhost:11434";
  const engine = createOpenAIEngine({
    ...opts,
    apiKey: undefined,
    endpoint: `${baseUrl}/v1/chat/completions`,
    model: opts.model ?? "llama3.1",
  });
  return { ...engine, id: "ollama", label: "Ollama (local)" };
}

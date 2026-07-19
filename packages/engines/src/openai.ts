import type {
  Engine,
  EngineRequest,
  EngineResult,
  GlossaryEntry,
  Segment,
  TranslatedSegment,
} from "@lumen/core";
import { TranslationError } from "@lumen/core";

/**
 * OpenAI Chat Completions engine. Works with any OpenAI-compatible endpoint
 * (OpenAI, Azure OpenAI, OpenRouter, SiliconFlow, DeepSeek, Ollama's OpenAI
 * compat endpoint, etc.).
 */
export interface OpenAIEngineOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /** Temperature for translation (default 0). */
  temperature?: number;
  /** Extra headers (e.g. for OpenRouter). */
  headers?: Record<string, string>;
}

interface ChatChoice {
  message?: { content?: string };
}

interface ChatResponse {
  choices?: ChatChoice[];
  error?: { message?: string };
}

const DEFAULT_SYSTEM_PROMPT = `You are a professional translation engine.
Translate the user's text from {SOURCE} to {TARGET}.
Rules:
- Return ONLY the translation, no explanations, no quotes.
- Preserve inline markers like <0>...</0> exactly.
- Preserve line breaks.
- Respect the provided glossary when given.
- If the text is already in the target language, return it unchanged.`;

export function createOpenAIEngine(
  opts: OpenAIEngineOptions = {},
): Engine {
  const endpoint = opts.endpoint ?? "https://api.openai.com/v1/chat/completions";
  const model = opts.model ?? "gpt-4o-mini";
  return {
    id: "openai",
    label: "OpenAI / Compatible",
    supportsStreaming: true,
    supportsBatch: true,
    async translate(req): Promise<EngineResult> {
      const { pair, segments, glossary } = req;
      if (segments.length === 0) return { segments: [] };
      const system = (opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT)
        .replace("{SOURCE}", pair.source === "auto" ? "the source language" : pair.source)
        .replace("{TARGET}", pair.target);
      const user = buildUserMessage(segments, glossary);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
          ...opts.headers,
        },
        body: JSON.stringify({
          model,
          temperature: opts.temperature ?? 0,
          stream: false,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ChatResponse;
        throw new TranslationError(
          `OpenAI HTTP ${res.status}: ${body.error?.message ?? ""}`,
          "openai",
        );
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? "";
      const parts = parseBatchResponse(content, segments);
      return { segments: parts };
    },
    async *translateStream(req): AsyncIterable<TranslatedSegment> {
      const { pair, segments, glossary } = req;
      if (segments.length === 0) return;
      const system = (opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT)
        .replace("{SOURCE}", pair.source === "auto" ? "the source language" : pair.source)
        .replace("{TARGET}", pair.target);
      const user = buildUserMessage(segments, glossary);
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
          ...opts.headers,
        },
        body: JSON.stringify({
          model,
          temperature: opts.temperature ?? 0,
          stream: true,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as ChatResponse;
        throw new TranslationError(
          `OpenAI stream HTTP ${res.status}: ${body.error?.message ?? ""}`,
          "openai",
        );
      }
      // Single-segment fast path: yield the growing translation as it arrives.
      if (segments.length === 1) {
        const segId = segments[0].id;
        let acc = "";
        for await (const delta of sseDeltas(res.body)) {
          acc += delta;
          yield { id: segId, text: acc };
        }
        yield { id: segId, text: acc.trim() };
        return;
      }
      // Multi-segment: buffer the full response then emit parsed parts.
      let full = "";
      for await (const delta of sseDeltas(res.body)) full += delta;
      for (const part of parseBatchResponse(full, segments)) yield part;
    },
  };
}

/** Read OpenAI SSE `data:` lines and yield concatenated content deltas. */
async function* sseDeltas(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // partial JSON; keep buffering
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Build a batched user message. We tag each segment with an index marker so we
 * can split the model's response back into per-segment translations.
 */
function buildUserMessage(segments: Segment[], glossary?: GlossaryEntry[]): string {
  let msg = "";
  if (glossary && glossary.length > 0) {
    msg += "Glossary:\n";
    for (const g of glossary) {
      msg += `- "${g.source}" -> "${g.target}"\n`;
    }
    msg += "\n";
  }
  if (segments.length === 1) {
    return msg + segments[0].text;
  }
  msg +=
    "Translate each of the following blocks. Keep the [[n]] marker at the start of each translated block.\n\n";
  for (const seg of segments) {
    msg += `[[${seg.id}]]\n${seg.text}\n\n`;
  }
  return msg.trim();
}

function parseBatchResponse(content: string, segments: Segment[]): TranslatedSegment[] {
  if (segments.length === 1) {
    return [{ id: segments[0].id, text: content.trim() }];
  }
  const map = new Map<string, string>();
  const re = /\[\[([^\]]+)\]\]\n?([\s\S]*?)(?=\n\[\[|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    map.set(m[1], m[2].trim());
  }
  // Fallback: if markers were dropped, return the whole content for the first
  // segment and empty for the rest so the caller can see something.
  if (map.size === 0) {
    return segments.map((seg, i) => ({
      id: seg.id,
      text: i === 0 ? content.trim() : "",
    }));
  }
  return segments.map((seg) => ({
    id: seg.id,
    text: map.get(seg.id) ?? "",
  }));
}

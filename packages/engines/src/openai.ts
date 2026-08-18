import type {
  Engine,
  EngineRequest,
  EngineResult,
  GlossaryEntry,
  Segment,
  TranslatedSegment,
} from "@lumen/core";
import { TranslationError } from "@lumen/core";
import { fetchWithRetry, type EngineFetchOptions } from "./fetch-utils.js";

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
  /** Request timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Max retries on 429/503 (default 3). */
  maxRetries?: number;
  /**
   * Extra JSON fields deep-merged into the chat request body (extra wins on
   * conflict). Used for provider-specific flags such as the catalog's
   * `quirks.no_thinking.body_params` (e.g. `{"thinking":{"type":"disabled"}}`
   * for MiniMax/DeepSeek or `{"enable_thinking":false}` for Qwen).
   */
  extraBody?: Record<string, unknown>;
}

interface ChatChoice {
  message?: { content?: string };
}

interface ChatResponse {
  choices?: ChatChoice[];
  error?: { message?: string };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function buildRequestBody(
  base: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return extra ? deepMergeBody(base, extra) : base;
}

/** Deep-merge `extra` into `base` (extra wins on scalar/array conflicts). */
function deepMergeBody(
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMergeBody(cur, v) : v;
  }
  return out;
}

const DEFAULT_SYSTEM_PROMPT = `You are a professional {TARGET} native translator and writer.
Translate the user's text from {SOURCE} to {TARGET}.

PRIORITY ORDER:
1. Preserve exact names and glossary terms.
2. Match the original tone and formality.
3. Use natural {TARGET} phrasing — never word-for-word.
4. Preserve meaning completely; do not omit or add content.

Rules:
- Output ONLY the translation. No explanations, no quotes, no commentary.
  - WRONG: "Here is the translation: ..."
  - WRONG: "Sure! ..."
  - RIGHT: just the translated text, nothing else.
- Preserve inline markers like <0>...</0> exactly: never translate, remove, reorder, or add them. Example: "This is <0>important</0> text." -> "这是<0>重要的</0>文本。" (markers untouched, in place).
- Preserve line breaks, spacing, and paragraph structure.
- Respect the provided glossary exactly when given.
- If the text is already in {TARGET}, return it unchanged.`;

/** Render a system prompt template by substituting all {SOURCE}/{TARGET} slots. */
function renderSystemPrompt(template: string, source: string, target: string): string {
  return template
    .replaceAll("{SOURCE}", source)
    .replaceAll("{TARGET}", target);
}

/** Resolve the language label used for the {SOURCE} slot. */
function sourceLabel(pair: EngineRequest["pair"]): string {
  return pair.source === "auto" ? "the source language" : pair.source;
}

export function createOpenAIEngine(
  opts: OpenAIEngineOptions = {},
): Engine {
  const endpoint = opts.endpoint ?? "https://api.openai.com/v1/chat/completions";
  const model = opts.model ?? "gpt-4o-mini";
  const fetchOpts: EngineFetchOptions = {
    engineId: "openai",
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
  };
  return {
    id: "openai",
    label: "OpenAI / Compatible",
    supportsStreaming: true,
    supportsBatch: true,
    async translate(req): Promise<EngineResult> {
      const { pair, segments, glossary } = req;
      if (segments.length === 0) return { segments: [] };
      const system = renderSystemPrompt(
        opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        sourceLabel(pair),
        pair.target,
      );
      const user = buildUserMessage(segments, glossary);
      const res = await fetchWithRetry(
        endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
            ...opts.headers,
          },
          body: JSON.stringify(
            buildRequestBody(
              {
                model,
                temperature: opts.temperature ?? 0,
                stream: false,
                messages: [
                  { role: "system", content: system },
                  { role: "user", content: user },
                ],
              },
              opts.extraBody,
            ),
          ),
        },
        fetchOpts,
      );
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
      const system = renderSystemPrompt(
        opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        sourceLabel(pair),
        pair.target,
      );
      const user = buildUserMessage(segments, glossary);
      const res = await fetchWithRetry(
        endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
            ...opts.headers,
          },
          body: JSON.stringify(
            buildRequestBody(
              {
                model,
                temperature: opts.temperature ?? 0,
                stream: true,
                messages: [
                  { role: "system", content: system },
                  { role: "user", content: user },
                ],
              },
              opts.extraBody,
            ),
          ),
        },
        fetchOpts,
      );
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
      // Multi-segment: stream incrementally. After each delta, re-parse the
      // accumulated text into per-segment chunks and yield only the segments
      // whose text changed since the last emission. This gives the caller
      // true per-segment streaming progress instead of a single end-of-stream
      // burst.
      const seen = new Map<string, string>();
      let full = "";
      for await (const delta of sseDeltas(res.body)) {
        full += delta;
        for (const part of parsePartialSegments(full, segments)) {
          if (seen.get(part.id) !== part.text) {
            seen.set(part.id, part.text);
            yield { id: part.id, text: part.text };
          }
        }
      }
      // Final pass: make sure every requested segment is emitted at least
      // once with trimmed text, even if the model dropped a marker.
      for (const seg of segments) {
        const text = (seen.get(seg.id) ?? "").trim();
        if (seen.get(seg.id) !== text) {
          seen.set(seg.id, text);
          yield { id: seg.id, text };
        }
      }
    },
  };
}

/**
 * Read OpenAI SSE `data:` lines from a stream and yield concatenated content
 * deltas. Handles three correctness concerns:
 *
 * - Trailing buffer flush: when the stream closes with a final event that
 *   wasn't terminated by a newline, that event is still parsed and emitted.
 * - Error events: if a `data:` payload carries an `error` field, a
 *   {@link TranslationError} is thrown so the caller can surface it instead
 *   of silently ending the stream.
 * - `[DONE]` sentinel: terminates the stream.
 */
export async function* sseDeltas(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;

  const handleLine = (raw: string): string | null => {
    const line = raw.trim();
    if (!line || !line.startsWith("data:")) return null;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      done = true;
      return null;
    }
    let json: {
      choices?: Array<{ delta?: { content?: string } }>;
      error?: { message?: string };
    };
    try {
      json = JSON.parse(payload);
    } catch {
      // partial JSON; keep buffering for the next chunk
      return null;
    }
    if (json.error) {
      throw new TranslationError(
        `OpenAI stream error: ${json.error.message ?? ""}`,
        "openai",
      );
    }
    return json.choices?.[0]?.delta?.content ?? null;
  };

  try {
    while (true) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) {
        // Final decoder flush so any trailing multi-byte sequence resolves.
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const delta = handleLine(line);
        if (delta) yield delta;
        if (done) return;
      }
    }
    // Flush a trailing partial event (no final newline) so the last segment
    // produced by the server isn't lost.
    if (buffer.length > 0) {
      const delta = handleLine(buffer);
      if (delta) yield delta;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Build a batched user message. We tag each segment with an index marker so we
 * can split the model's response back into per-segment translations.
 *
 * Glossary entries are filtered to only those whose source term appears in
 * this batch (matching BabelDOC / TranslateBooksWithLLMs): the full glossary
 * is never sent, which keeps prompts small and lets providers cache the stable
 * system prompt. Segment `context.prev` is injected as read-only context so
 * terminology and tone stay consistent across paragraph boundaries.
 */
export function buildUserMessage(
  segments: Segment[],
  glossary?: GlossaryEntry[],
): string {
  let msg = "";
  const hits = filterGlossary(segments, glossary);
  if (hits.length > 0) {
    msg +=
      "Glossary (use these EXACT translations whenever the source term appears; do not paraphrase):\n";
    for (const g of hits) {
      msg += `- "${escapeGlossaryText(g.source)}" -> "${escapeGlossaryText(g.target)}"\n`;
    }
    msg += "\n";
  }
  const context = collectContext(segments);
  if (context) {
    msg += `Context (previous text, for consistency only — do NOT translate it):\n${context}\n\n`;
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

/**
 * Keep only glossary entries whose source term literally appears in the batch.
 * Case-insensitive for Latin scripts; exact match for CJK and other scripts
 * where case folding does not apply. Terms containing newlines are skipped so
 * they can never break the prompt structure.
 */
function filterGlossary(
  segments: Segment[],
  glossary?: GlossaryEntry[],
): GlossaryEntry[] {
  if (!glossary || glossary.length === 0) return [];
  const haystack = segments.map((seg) => seg.text).join("\n");
  const lowered = haystack.toLowerCase();
  const seen = new Set<string>();
  const hits: GlossaryEntry[] = [];
  for (const g of glossary) {
    const source = g.source.trim();
    if (source === "" || source.includes("\n")) continue;
    const hit = isAscii(source)
      ? lowered.includes(source.toLowerCase())
      : haystack.includes(source);
    if (!hit || seen.has(source)) continue;
    seen.add(source);
    hits.push(g);
  }
  return hits;
}

function isAscii(text: string): boolean {
  return /^[ -~]*$/.test(text);
}

/** Quote/CR/LF inside glossary terms could break the "- src -> tgt" lines. */
function escapeGlossaryText(text: string): string {
  return text.replaceAll('"', "'").replaceAll("\r", " ").replaceAll("\n", " ");
}

/** Cap for context text so a huge previous block cannot bloat the prompt. */
const CONTEXT_CHAR_LIMIT = 400;

/**
 * Collect unique `context.prev` snippets from the batch, in order. These give
 * the model cross-paragraph continuity (terminology, names, tone) without
 * asking it to translate anything but the batch itself.
 *
 * Context that is already visible as a segment's text in this batch is
 * skipped: in a contiguous batch, only the first segment's `context.prev`
 * comes from outside the batch; every subsequent segment's `context.prev` is
 * the previous segment's text, which already appears in a `[[n]]` translation
 * block. Including it again would duplicate source text in both the
 * read-only context block and the translation blocks, wasting tokens and
 * risking model confusion.
 */
function collectContext(segments: Segment[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const seg of segments) {
    const prev = seg.context?.prev?.trim();
    if (!prev || seen.has(prev)) continue;
    // Skip context whose text is already a segment in this batch (e.g. the
    // previous paragraph is also being translated here).
    if (segments.some((s) => s.text.includes(prev))) continue;
    seen.add(prev);
    parts.push(truncateMiddle(prev, CONTEXT_CHAR_LIMIT));
  }
  return parts.join("\n---\n");
}

function truncateMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
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

/**
 * Parse a partial (mid-stream) batched response into per-segment chunks.
 * Unlike {@link parseBatchResponse}, this never falls back to dumping the
 * whole content into the first segment, because mid-stream we may simply not
 * have received the first marker yet. The trailing (still-streaming) segment
 * is included with whatever text has arrived so far.
 */
export function parsePartialSegments(
  content: string,
  segments: Segment[],
): TranslatedSegment[] {
  if (segments.length === 1) {
    return [{ id: segments[0].id, text: content.trim() }];
  }
  const out: TranslatedSegment[] = [];
  const re = /\[\[([^\]]+)\]\]\n?([\s\S]*?)(?=\n\[\[|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ id: m[1], text: m[2].trim() });
  }
  return out;
}

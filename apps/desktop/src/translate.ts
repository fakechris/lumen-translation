/**
 * Translation service — the Windows counterpart of `LLMService.swift`.
 *
 * The user's selected provider is tried first; on any failure (e.g. Google's
 * HTTP 429 CAPTCHA rate-limit) it falls back to the free MT engines
 * (Microsoft, then Google) and finally to any configured LLM that has an API
 * key set. The first provider that succeeds wins, and its label is reported
 * back so the window can show which engine produced the result.
 *
 * Unlike the Swift version, the provider wire formats are not reimplemented
 * here: `@lumen/engines` already speaks all three (Google's free endpoint,
 * Microsoft's Edge-token endpoint, and OpenAI-compatible chat), with shared
 * timeout/retry semantics. This module is only the routing and fallback layer.
 */

import type { Engine } from '@lumen/core';
import { createGoogleEngine, createMicrosoftEngine, createOpenAIEngine } from '@lumen/engines';
import { noThinkingInjection, type ProviderPreset } from './catalog';
import { langLabel } from './lang';
import {
  activeProvider,
  allProviders,
  apiKeyFor,
  endpointFor,
  findProviderOrCustom,
  modelFor,
  type Settings,
} from './settings';

/**
 * The translation system prompt. Deliberately *not* part of the provider
 * catalog v1: call-parameter defaults are product policy, not vendor facts
 * (lumen-suite `contracts/PROVIDER_CATALOG.md` §6.15). Kept byte-identical to
 * the macOS app's prompt so both platforms produce the same style of output.
 */
const SYSTEM_PROMPT = `You are a professional, native-level translator{SOURCE_HINT}. \
Translate the user's text into {TARGET_LABEL}, producing a version that \
reads as if originally written by a fluent native speaker — faithful, \
natural, and idiomatic (信达雅).

Rules:
- Convey the meaning, not the words. Rewrite phrasing so it flows \
naturally in {TARGET_LABEL}; never produce word-for-word or stiff, \
machine-sounding output.
- Match the register and tone of the original: casual stays casual, \
formal stays formal. Do NOT over-formalize or "improve" the writing.
- Use the target language's own idioms, word order, and punctuation \
conventions rather than mirroring the source structure.
- Preserve the original meaning, tone, paragraph breaks, and level of \
formality.
- Keep product names, brand names, person names, URLs, email addresses, \
code, and file paths unchanged unless they have a widely accepted \
localized form.
- If part of the input is already in {TARGET_LABEL}, keep it natural and \
do not comment on it.
- Return only the translation. Do not add explanations, labels, notes, \
or a preamble.`;

const TEMPERATURE = 0.3;

/**
 * Long selections are split into order-preserving chunks of at most
 * `maxChars` characters on paragraph boundaries (blank lines) before they
 * reach a provider. Without this a 17 KB document becomes one request whose
 * full-length generation blows the engine's request timeout. Mirrors
 * `chunkForTranslation` in the macOS app (`LLMService.swift`).
 */
export const CHUNK_MAX_CHARS = 3000;

export function chunkText(text: string, maxChars: number = CHUNK_MAX_CHARS): string[] {
  if (text.length <= maxChars) return [text];
  const paragraphs = text.split('\n\n');
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) continue;
    if (current.length === 0) current = paragraph;
    else if (current.length + paragraph.length + 2 <= maxChars) current += '\n\n' + paragraph;
    else {
      chunks.push(current);
      current = paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks.flatMap((c) => (c.length <= maxChars ? [c] : splitOverlong(c, maxChars)));
}

/** Hard-split an over-long paragraph (e.g. a single code block) on lines, then words. */
function splitOverlong(piece: string, maxChars: number): string[] {
  const lines = piece.split('\n');
  const out: string[] = [];
  let buffer = '';
  for (const line of lines) {
    if (!buffer) buffer = line;
    else if (buffer.length + line.length + 1 <= maxChars) buffer += '\n' + line;
    else {
      out.push(buffer);
      buffer = line;
    }
  }
  if (buffer) out.push(buffer);
  return out.flatMap((c) => (c.length <= maxChars ? [c] : wrapWords(c, maxChars)));
}

function wrapWords(chunk: string, maxChars: number): string[] {
  const words = chunk.split(/(\s+)/);
  const out: string[] = [];
  let buffer = '';
  for (const word of words) {
    if (word.length === 0) continue;
    if (!buffer) buffer = word;
    else if (buffer.length + word.length <= maxChars) buffer += word;
    else {
      out.push(buffer);
      buffer = word;
    }
  }
  if (buffer) out.push(buffer);
  return out.flatMap((c) => (c.length <= maxChars ? [c] : hardCut(c, maxChars)));
}

function hardCut(str: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < str.length; i += maxChars) out.push(str.slice(i, i + maxChars));
  return out;
}

export interface TranslateContext {
  previousSource?: string;
  previousTranslation?: string;
}

/**
 * Format context for live subtitles or single-sentence streaming translation.
 * Delivers previous 1-2 sentences as context to ensure pronoun, tense, and
 * terminology coherence without polluting the translated output.
 */
export function contextAwareUserContent(
  text: string,
  context: TranslateContext | undefined,
): string {
  if (!context || (!context.previousSource && !context.previousTranslation)) {
    return text;
  }
  const parts: string[] = [];
  if (context.previousSource?.trim()) {
    parts.push(`Previous source context: ${context.previousSource.trim().slice(0, 400)}`);
  }
  if (context.previousTranslation?.trim()) {
    parts.push(`Previous translation context: ${context.previousTranslation.trim().slice(0, 400)}`);
  }
  return `Context for continuity (do NOT re-translate, do NOT repeat context in output):\n${parts.join('\n')}\n\n--- Text to translate ---\n${text}`;
}

/**
 * User message for one chunk of a split long selection. Single-chunk texts
 * go through verbatim; later chunks carry the previous chunk's translation
 * as read-only context so names and terminology stay consistent, and the
 * chunk to translate is delimited so the context never leaks into output.
 */
export function chunkUserContent(
  text: string,
  previousTranslation: string | undefined,
  index: number,
  count: number,
): string {
  if (count <= 1) return text;
  const prefix = `This is part ${index + 1} of ${count}. `;
  if (previousTranslation) {
    return `${prefix}For consistency, here is my translation of the previous part (do not re-translate or repeat it):\n${previousTranslation.slice(0, 1200)}\n\n--- Text to translate ---\n${text}`;
  }
  return `${prefix}Translate the text below.\n\n--- Text to translate ---\n${text}`;
}

export interface TranslationResult {
  translation: string;
  /** Label of the provider that actually produced the result. */
  engine: string;
}

export interface TranslateOptions {
  /**
   * Called with the partial translation as it streams in. Only OpenAI-
   * compatible providers stream; the MT engines deliver in one shot.
   */
  onPartial?: (partial: string, engineLabel: string) => void;
  signal?: AbortSignal;
  context?: TranslateContext;
}

export class TranslationFailed extends Error {}

function buildSystemPrompt(source: string, target: string): string {
  const sourceHint = !source || source === 'auto' ? '' : ` (from ${langLabel(source)})`;
  return SYSTEM_PROMPT.replace(/\{TARGET_LABEL\}/g, langLabel(target)).replace(
    '{SOURCE_HINT}',
    sourceHint,
  );
}

/**
 * Ordered list of providers to try, mirroring `fallbackChain` in
 * `LLMService.swift`: the user's selection, then the free keyless MT engines,
 * then any configured LLM. Duplicates and key-needing providers without a key
 * are skipped.
 */
export function fallbackChain(s: Settings): ProviderPreset[] {
  const chain: ProviderPreset[] = [];
  const seen = new Set<string>();
  const add = (preset: ProviderPreset | undefined) => {
    if (!preset || seen.has(preset.id)) return;
    if (preset.needsKey && !apiKeyFor(s, preset.id)) return;
    chain.push(preset);
    seen.add(preset.id);
  };
  add(activeProvider(s));
  add(findProviderOrCustom(s, 'microsoft_translator'));
  add(findProviderOrCustom(s, 'google_translate'));
  // Any configured LLM: catalog providers plus the user's custom
  // OpenAI-compatible endpoint slots.
  for (const preset of allProviders(s)) {
    if (preset.apiStyle === 'openai_compat') add(preset);
  }
  return chain;
}

/** Build the `@lumen/engines` adapter for one preset. */
function engineFor(preset: ProviderPreset, s: Settings): Engine {
  const endpoint = endpointFor(s, preset);
  if (!endpoint) {
    throw new TranslationFailed(`${preset.label}: endpoint is not configured`);
  }
  switch (preset.apiStyle) {
    case 'google_translate':
      // The engine appends its own query string, so hand it the bare path.
      return createGoogleEngine({
        endpoint: `${endpoint}?client=gtx&dt=t`,
      });
    case 'microsoft_translator':
      return createMicrosoftEngine({ endpoint });
    default: {
      const model = modelFor(s, preset.id);
      return createOpenAIEngine({
        apiKey: apiKeyFor(s, preset.id),
        endpoint,
        model,
        temperature: TEMPERATURE,
        systemPrompt: buildSystemPrompt(s.sourceLang, s.targetLang),
        headers: preset.extraHeaders,
        extraBody: noThinkingInjection(preset, model),
      });
    }
  }
}

async function attemptOne(
  preset: ProviderPreset,
  chunks: string[],
  s: Settings,
  opts: TranslateOptions,
): Promise<string> {
  const engine = engineFor(preset, s);
  // Only LLM providers carry context; the free MT engines translate each chunk verbatim.
  const hasContext =
    preset.apiStyle !== 'google_translate' && preset.apiStyle !== 'microsoft_translator';
  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (opts.signal?.aborted) throw new TranslationFailed('aborted');
    let text = chunks[i];
    if (hasContext) {
      if (chunks.length > 1) {
        text = chunkUserContent(chunks[i], i > 0 ? parts[i - 1] : undefined, i, chunks.length);
      } else if (opts.context) {
        text = contextAwareUserContent(chunks[0], opts.context);
      }
    }
    const req = {
      pair: { source: s.sourceLang, target: s.targetLang },
      segments: [{ id: String(i), text }],
    };

    // Stream when the provider supports it so long passages appear
    // progressively instead of after a 20 s wait. The cumulative result
    // (previous chunks + this chunk's partial) is what a user sees.
    if (opts.onPartial && engine.translateStream) {
      let last = '';
      for await (const seg of engine.translateStream(req)) {
        if (opts.signal?.aborted) throw new TranslationFailed('aborted');
        last = seg.text;
        opts.onPartial([...parts, last].join('\n\n'), preset.label);
      }
      const out = last.trim();
      if (!out) throw new TranslationFailed('empty response');
      parts.push(out);
    } else {
      if (opts.signal?.aborted) throw new TranslationFailed('aborted');
      const res = await engine.translate(req);
      if (opts.signal?.aborted) throw new TranslationFailed('aborted');
      const out = (res.segments[0]?.text ?? '').trim();
      if (!out) throw new TranslationFailed('empty response');
      parts.push(out);
    }
  }
  const joined = parts.join('\n\n').trim();
  if (!joined) throw new TranslationFailed('empty response');
  return joined;
}

/**
 * Translate `text`, walking the fallback chain until one provider succeeds.
 * Throws {@link TranslationFailed} with the last error if all of them fail.
 */
export async function translate(
  text: string,
  s: Settings,
  opts: TranslateOptions = {},
): Promise<TranslationResult> {
  const chain = fallbackChain(s);
  const truncated = text.length > s.maxSelectionChars ? text.slice(0, s.maxSelectionChars) : text;
  const chunks = chunkText(truncated);
  let lastError = 'no translation provider available';

  for (const preset of chain) {
    if (opts.signal?.aborted) throw new TranslationFailed('aborted');
    try {
      const translation = await attemptOne(preset, chunks, s, opts);
      return { translation, engine: preset.label };
    } catch (err) {
      if (opts.signal?.aborted) throw new TranslationFailed('aborted');
      lastError = `${preset.label}: ${(err as Error).message}`;
      console.warn(`[lumen] ${preset.id} failed; trying next provider`, err);
    }
  }
  throw new TranslationFailed(lastError);
}

interface FlightRequest {
  id: string;
  sourceText: string;
  abortController: AbortController;
}

/**
 * Flight controller for streaming live subtitles.
 * Manages AbortControllers to cancel obsolete in-flight draft translations
 * and deduplicate / cancel superseded final translations.
 */
export class TranslationFlightController {
  private draftFlight: FlightRequest | null = null;
  private finalFlights: Map<string, FlightRequest> = new Map();

  /**
   * Schedule or dispatch a draft (partial) translation.
   * Cancels any previously in-flight draft translation.
   */
  async requestDraft(
    utterance: number,
    sourceText: string,
    settings: Settings,
    onSuccess: (result: TranslationResult) => void,
    context?: TranslateContext,
  ): Promise<void> {
    const trimmed = sourceText.trim();
    if (!trimmed) {
      this.cancelDraft();
      return;
    }
    // Cancel prior draft flight
    this.cancelDraft();

    const abortController = new AbortController();
    const flight: FlightRequest = {
      id: `draft-${utterance}`,
      sourceText: trimmed,
      abortController,
    };
    this.draftFlight = flight;

    try {
      const result = await translate(trimmed, settings, {
        signal: abortController.signal,
        context,
        onPartial: (partialText, engineLabel) => {
          if (this.draftFlight === flight && !abortController.signal.aborted) {
            onSuccess({ translation: partialText, engine: engineLabel });
          }
        },
      });
      if (this.draftFlight === flight && !abortController.signal.aborted) {
        this.draftFlight = null;
        onSuccess(result);
      }
    } catch (err) {
      if (this.draftFlight === flight) {
        this.draftFlight = null;
      }
      if (err instanceof TranslationFailed && err.message === 'aborted') {
        return;
      }
      throw err;
    }
  }

  /**
   * Schedule or dispatch a final (committed or refined) caption translation.
   * Cancels any previously in-flight translation for the same utterance ID.
   */
  async requestFinal(
    id: string,
    sourceText: string,
    settings: Settings,
    onSuccess: (result: TranslationResult) => void,
    context?: TranslateContext,
  ): Promise<void> {
    const trimmed = sourceText.trim();
    if (!trimmed) {
      this.cancelFinal(id);
      return;
    }
    // Cancel prior flight for this utterance slot
    this.cancelFinal(id);

    const abortController = new AbortController();
    const flight: FlightRequest = {
      id,
      sourceText: trimmed,
      abortController,
    };
    this.finalFlights.set(id, flight);

    try {
      const result = await translate(trimmed, settings, {
        signal: abortController.signal,
        context,
        onPartial: (partialText, engineLabel) => {
          if (this.finalFlights.get(id) === flight && !abortController.signal.aborted) {
            onSuccess({ translation: partialText, engine: engineLabel });
          }
        },
      });
      if (this.finalFlights.get(id) === flight && !abortController.signal.aborted) {
        this.finalFlights.delete(id);
        onSuccess(result);
      }
    } catch (err) {
      if (this.finalFlights.get(id) === flight) {
        this.finalFlights.delete(id);
      }
      if (err instanceof TranslationFailed && err.message === 'aborted') {
        return;
      }
      throw err;
    }
  }

  cancelDraft(): void {
    if (this.draftFlight) {
      this.draftFlight.abortController.abort();
      this.draftFlight = null;
    }
  }

  cancelFinal(id: string): void {
    const flight = this.finalFlights.get(id);
    if (flight) {
      flight.abortController.abort();
      this.finalFlights.delete(id);
    }
  }

  abortAll(): void {
    this.cancelDraft();
    for (const flight of this.finalFlights.values()) {
      flight.abortController.abort();
    }
    this.finalFlights.clear();
  }
}


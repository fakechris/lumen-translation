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

import type { Engine } from "@lumen/core";
import {
  createGoogleEngine,
  createMicrosoftEngine,
  createOpenAIEngine,
} from "@lumen/engines";
import { noThinkingInjection, type ProviderPreset } from "./catalog";
import { langLabel } from "./lang";
import {
  activeProvider,
  allProviders,
  apiKeyFor,
  endpointFor,
  findProviderOrCustom,
  modelFor,
  type Settings,
} from "./settings";

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
}

export class TranslationFailed extends Error {}

function buildSystemPrompt(source: string, target: string): string {
  const sourceHint =
    !source || source === "auto" ? "" : ` (from ${langLabel(source)})`;
  return SYSTEM_PROMPT.replace(
    /\{TARGET_LABEL\}/g,
    langLabel(target),
  ).replace("{SOURCE_HINT}", sourceHint);
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
  add(findProviderOrCustom(s, "microsoft_translator"));
  add(findProviderOrCustom(s, "google_translate"));
  // Any configured LLM: catalog providers plus the user's custom
  // OpenAI-compatible endpoint slots.
  for (const preset of allProviders(s)) {
    if (preset.apiStyle === "openai_compat") add(preset);
  }
  return chain;
}

/** Build the `@lumen/engines` adapter for one preset. */
function engineFor(preset: ProviderPreset, s: Settings): Engine {
  const endpoint = endpointFor(s, preset);
  switch (preset.apiStyle) {
    case "google_translate":
      // The engine appends its own query string, so hand it the bare path.
      return createGoogleEngine({
        endpoint: `${endpoint}?client=gtx&dt=t`,
      });
    case "microsoft_translator":
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
  text: string,
  s: Settings,
  opts: TranslateOptions,
): Promise<string> {
  const engine = engineFor(preset, s);
  const req = {
    pair: { source: s.sourceLang, target: s.targetLang },
    segments: [{ id: "0", text }],
  };

  // Stream when the provider supports it so long passages appear progressively
  // instead of after a 20 s wait.
  if (opts.onPartial && engine.translateStream) {
    let last = "";
    for await (const seg of engine.translateStream(req)) {
      last = seg.text;
      opts.onPartial(last, preset.label);
    }
    const out = last.trim();
    if (!out) throw new TranslationFailed("empty response");
    return out;
  }

  const res = await engine.translate(req);
  const out = (res.segments[0]?.text ?? "").trim();
  if (!out) throw new TranslationFailed("empty response");
  return out;
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
  const truncated =
    text.length > s.maxSelectionChars ? text.slice(0, s.maxSelectionChars) : text;
  let lastError = "no translation provider available";

  for (const preset of chain) {
    if (opts.signal?.aborted) throw new TranslationFailed("aborted");
    try {
      const translation = await attemptOne(preset, truncated, s, opts);
      return { translation, engine: preset.label };
    } catch (err) {
      lastError = `${preset.label}: ${(err as Error).message}`;
      console.warn(`[lumen] ${preset.id} failed; trying next provider`, err);
    }
  }
  throw new TranslationFailed(lastError);
}

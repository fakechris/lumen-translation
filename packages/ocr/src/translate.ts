import { translateAll } from "@lumen/core";
import type { Engine, GlossaryEntry, LanguagePair } from "@lumen/core";
import { ocrImage } from "./ocr.js";
import type { OcrOptions, OcrResult } from "./types.js";

export interface OcrTranslateOptions extends OcrOptions {
  /** Optional glossary entries applied to the translated text. */
  glossary?: GlossaryEntry[];
  /** Concurrency passed to translateAll. */
  concurrency?: number;
}

/**
 * Extract text from an image with OCR, then translate the whole extracted text.
 */
export async function ocrAndTranslate(
  source: string | Blob | URL,
  engine: Engine,
  pair: LanguagePair,
  opts: OcrTranslateOptions = {},
): Promise<{ original: OcrResult; translated: string }> {
  const original = await ocrImage(source, opts);
  const result = await translateAll(
    engine,
    {
      pair,
      segments: [{ id: "ocr", text: original.text }],
      glossary: opts.glossary,
    },
    { concurrency: opts.concurrency },
  );
  const translated = result.segments[0]?.text ?? "";
  return { original, translated };
}

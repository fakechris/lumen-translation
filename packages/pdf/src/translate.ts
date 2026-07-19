import { dedupeSegments, translateAll } from "@lumen/core";
import type {
  Engine,
  GlossaryEntry,
  LanguagePair,
  Segment,
  TranslatedSegment,
} from "@lumen/core";
import type { PdfBilingualPage, PdfPage } from "./types.js";
import { groupIntoParagraphs } from "./paragraphs.js";

export interface TranslatePdfOptions {
  glossary?: GlossaryEntry[];
  concurrency?: number;
  maxBatchSize?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Translate the text extracted from PDF pages.
 *
 * Paragraphs are collected across all pages, deduplicated, and passed to the
 * engine via `translateAll`. Translations are written back into each paragraph
 * and progress is reported as translations are completed.
 */
export async function translatePdf(
  pages: PdfPage[],
  engine: Engine,
  pair: LanguagePair,
  opts: TranslatePdfOptions = {},
): Promise<PdfBilingualPage[]> {
  const bilingualPages: PdfBilingualPage[] = pages.map((page) => ({
    index: page.index,
    paragraphs: groupIntoParagraphs(page),
  }));

  const segments: Segment[] = [];
  for (const page of bilingualPages) {
    for (const paragraph of page.paragraphs) {
      segments.push({
        id: paragraph.id,
        text: paragraph.text,
        meta: { pageIndex: page.index, paragraphId: paragraph.id },
      });
    }
  }

  const { unique, restore } = dedupeSegments(segments);
  const result = await translateAll(
    engine,
    {
      pair,
      segments: unique,
      glossary: opts.glossary,
    },
    {
      concurrency: opts.concurrency,
      maxBatchSize: opts.maxBatchSize,
    },
  );

  const restored = restore(result.segments);
  const byId = new Map(restored.map((seg) => [seg.id, seg.text]));

  let done = 0;
  const total = segments.length;

  for (const page of bilingualPages) {
    for (const paragraph of page.paragraphs) {
      const translated = byId.get(paragraph.id);
      if (translated !== undefined) {
        paragraph.translated = translated;
      }
      done++;
    }
    opts.onProgress?.(done, total);
  }

  return bilingualPages;
}

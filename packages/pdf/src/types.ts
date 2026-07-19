/**
 * A single text item extracted from a PDF page.
 *
 * Mirrors pdf.js `TextItem` minimally: `str` is preserved for parity with the
 * upstream shape, but callers should prefer `text`.
 */
export interface PdfTextItem {
  text: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
  str?: string;
}

/** One page of a PDF document with its extracted text items. */
export interface PdfPage {
  index: number;
  width: number;
  height: number;
  items: PdfTextItem[];
}

/** A heuristic paragraph discovered inside a PDF page. */
export interface PdfParagraph {
  id: string;
  text: string;
  translated?: string;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/** A page after grouping its text items into paragraphs. */
export interface PdfBilingualPage {
  index: number;
  paragraphs: PdfParagraph[];
}

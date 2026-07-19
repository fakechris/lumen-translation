import type { PdfPage, PdfTextItem } from "./types.js";

export interface LoadPdfOptions {
  /** URL of the pdf.js worker script. The host page is responsible for hosting it. */
  workerSrc?: string;
}

export interface LoadedPdf {
  pages: PdfPage[];
  numPages: number;
}

/**
 * Load a PDF from an ArrayBuffer and extract text items.
 *
 * pdfjs-dist is imported dynamically so the package is not bundled unless PDF
 * extraction is actually used. The caller must set `workerSrc` themselves or
 * have configured the host environment so that the pdf.js worker is found.
 */
export async function loadPdf(
  data: ArrayBuffer,
  opts: LoadPdfOptions = {},
): Promise<LoadedPdf> {
  const pdfjs = await import("pdfjs-dist");

  if (opts.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = opts.workerSrc;
  }

  const loadingTask = pdfjs.getDocument({ data });
  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  const pages: PdfPage[] = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();
    const items: PdfTextItem[] = [];

    for (const raw of textContent.items) {
      const item = raw as { str?: string; transform?: number[]; width?: number; height?: number; fontName?: string };
      if (typeof item.str !== "string" || item.str.trim() === "") {
        continue;
      }
      items.push({
        text: item.str,
        str: item.str,
        transform: item.transform ?? [],
        width: item.width ?? 0,
        height: item.height ?? 0,
        fontName: item.fontName,
      });
    }

    pages.push({
      index: i,
      width: viewport.width,
      height: viewport.height,
      items,
    });
  }

  return { pages, numPages };
}

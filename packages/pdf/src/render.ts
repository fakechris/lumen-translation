import type { PdfBilingualPage } from "./types.js";

export type PdfRenderStyle = "blue" | "green" | "plain" | "minimal";

export interface RenderBilingualPdfOptions {
  bilingual: boolean;
  style?: PdfRenderStyle;
}

/**
 * Render translated PDF paragraphs into a DOM container as a reflowed document.
 *
 * This produces a readable bilingual page layout rather than overlaying the
 * translation on top of the original PDF canvas. The trade-off is that the
 * visual fidelity of the original PDF (precise font, positioning, and images)
 * is intentionally sacrificed in favor of a clean, translatable text flow.
 */
export function renderBilingualPdf(
  pages: PdfBilingualPage[],
  container: HTMLElement,
  opts: RenderBilingualPdfOptions,
): void {
  container.innerHTML = "";
  const style = opts.style ?? "blue";

  for (const page of pages) {
    const pageEl = document.createElement("div");
    pageEl.className = "lumen-pdf-page";

    for (const paragraph of page.paragraphs) {
      const original = document.createElement("p");
      original.textContent = paragraph.text;
      pageEl.appendChild(original);

      if (opts.bilingual) {
        const translation = document.createElement("p");
        translation.className = "lumen-pdf-translation";
        translation.setAttribute("data-lumen-style", style);
        translation.textContent = paragraph.translated ?? "";
        pageEl.appendChild(translation);
      }
    }

    container.appendChild(pageEl);
  }
}

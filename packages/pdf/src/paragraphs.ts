import type { PdfPage, PdfParagraph, PdfTextItem } from "./types.js";

function median(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function bbox(items: PdfTextItem[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const item of items) {
    const x = item.transform[4] ?? 0;
    const y = item.transform[5] ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + item.width);
    maxY = Math.max(maxY, y + item.height);
  }

  return {
    x: minX === Infinity ? 0 : minX,
    y: minY === Infinity ? 0 : minY,
    width: maxX === -Infinity ? 0 : Math.max(0, maxX - minX),
    height: maxY === -Infinity ? 0 : Math.max(0, maxY - minY),
  };
}

function itemY(item: PdfTextItem): number {
  return item.transform[5] ?? 0;
}

function itemX(item: PdfTextItem): number {
  return item.transform[4] ?? 0;
}

/**
 * Group a PDF page's text items into heuristic paragraphs.
 *
 * Algorithm:
 * 1. Compute the median item height as a line-height proxy.
 * 2. Cluster items into lines: items whose y coordinates differ by less than
 *    the median height share a line.
 * 3. Sort each line left-to-right by x.
 * 4. Merge adjacent lines into a paragraph when the vertical gap between them
 *    is smaller than 1.5× the median line height.
 *
 * This is intentionally simple and tolerant of the noise PDF text extraction
 * produces.
 */
export function groupIntoParagraphs(page: PdfPage): PdfParagraph[] {
  if (page.items.length === 0) return [];

  const medianHeight = median(page.items.map((item) => item.height));
  const lineThreshold = medianHeight;
  const paragraphGapThreshold = medianHeight * 1.5;

  const sortedItems = page.items.slice().sort((a, b) => {
    const dy = itemY(a) - itemY(b);
    if (Math.abs(dy) >= lineThreshold) return dy;
    return itemX(a) - itemX(b);
  });

  // Build lines by y-proximity.
  const lines: PdfTextItem[][] = [];
  for (const item of sortedItems) {
    let placed = false;
    const y = itemY(item);
    for (const line of lines) {
      const lineY = itemY(line[0]);
      if (Math.abs(y - lineY) < lineThreshold) {
        line.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) {
      lines.push([item]);
    }
  }

  // Sort each line left-to-right and order lines top-to-bottom.
  for (const line of lines) {
    line.sort((a, b) => itemX(a) - itemX(b));
  }
  lines.sort((a, b) => itemY(a[0]) - itemY(b[0]));

  // Merge lines into paragraphs by small vertical gaps.
  const groups: PdfTextItem[][] = [];
  for (const line of lines) {
    const lineBbox = bbox(line);
    let merged = false;

    if (groups.length > 0) {
      const prevGroup = groups[groups.length - 1];
      const prevBbox = bbox(prevGroup);
      const gap = lineBbox.y - (prevBbox.y + prevBbox.height);
      if (gap < paragraphGapThreshold) {
        prevGroup.push(...line);
        merged = true;
      }
    }

    if (!merged) {
      groups.push([...line]);
    }
  }

  const paragraphs: PdfParagraph[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const text = group.map((item) => item.text).join(" ");
    paragraphs.push({
      id: `p${page.index}-${i}`,
      text,
      bbox: bbox(group),
    });
  }

  return paragraphs;
}

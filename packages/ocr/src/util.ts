import type { OcrBlock } from "./types.js";

/**
 * Clamp a bounding box so every coordinate stays inside [0, width] and [0, height].
 */
export function clampBbox(
  bbox: { x0: number; y0: number; x1: number; y1: number },
  width: number,
  height: number,
): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: Math.max(0, Math.min(bbox.x0, width)),
    y0: Math.max(0, Math.min(bbox.y0, height)),
    x1: Math.max(0, Math.min(bbox.x1, width)),
    y1: Math.max(0, Math.min(bbox.y1, height)),
  };
}

/**
 * Merge OCR blocks that are within `gap` pixels of each other.
 * Merged text is joined with spaces; the merged bbox is the union of members.
 */
export function mergeCloseBlocks(blocks: OcrBlock[], gap: number): OcrBlock[] {
  if (blocks.length === 0) return [];
  if (gap < 0) return blocks.map((b) => ({ ...b }));

  let groups: OcrBlock[][] = blocks.map((b) => [b]);

  let changed = true;
  while (changed) {
    changed = false;
    const merged: OcrBlock[][] = [];
    for (const group of groups) {
      const target = merged.find((m) => blocksClose(unionBlock(m), unionBlock(group), gap));
      if (target) {
        target.push(...group);
        changed = true;
      } else {
        merged.push(group);
      }
    }
    groups = merged;
  }

  return groups.map(unionBlock);
}

function blocksClose(a: OcrBlock, b: OcrBlock, gap: number): boolean {
  const hGap = Math.max(0, Math.max(a.bbox.x0, b.bbox.x0) - Math.min(a.bbox.x1, b.bbox.x1));
  const vGap = Math.max(0, Math.max(a.bbox.y0, b.bbox.y0) - Math.min(a.bbox.y1, b.bbox.y1));
  return hGap <= gap && vGap <= gap;
}

function unionBlock(group: OcrBlock[]): OcrBlock {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let totalWeight = 0;
  let weightedConfidence = 0;
  const texts: string[] = [];

  for (const b of group) {
    x0 = Math.min(x0, b.bbox.x0);
    y0 = Math.min(y0, b.bbox.y0);
    x1 = Math.max(x1, b.bbox.x1);
    y1 = Math.max(y1, b.bbox.y1);
    const weight = Math.max(1, b.text.length);
    totalWeight += weight;
    weightedConfidence += b.confidence * weight;
    texts.push(b.text);
  }

  return {
    text: texts.join(" "),
    bbox: { x0, y0, x1, y1 },
    confidence: totalWeight > 0 ? weightedConfidence / totalWeight : 0,
  };
}

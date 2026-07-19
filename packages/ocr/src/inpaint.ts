import type { OcrBlock } from "./types.js";

/**
 * Very basic inpainting: paint over each OCR block with the average color of
 * the pixels immediately surrounding it.
 *
 * This is intentionally a placeholder. A production inpainter would use a
 * trained diffusion/WASM model or an external service to reconstruct textures
 * behind the text.
 */
export function inpaintImage(image: HTMLCanvasElement, blocks: OcrBlock[]): HTMLCanvasElement {
  const output = document.createElement("canvas");
  output.width = image.width;
  output.height = image.height;

  const ctx = output.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to obtain 2D canvas context for inpainting.");
  }

  ctx.drawImage(image, 0, 0);
  const imageData = ctx.getImageData(0, 0, output.width, output.height);
  const pixels = imageData.data;

  for (const block of blocks) {
    const x0 = Math.max(0, Math.floor(block.bbox.x0));
    const y0 = Math.max(0, Math.floor(block.bbox.y0));
    const x1 = Math.min(output.width, Math.ceil(block.bbox.x1));
    const y1 = Math.min(output.height, Math.ceil(block.bbox.y1));

    const color = sampleAverageColor(pixels, output.width, output.height, x0, y0, x1, y1);
    fillRect(pixels, output.width, output.height, x0, y0, x1, y1, color);
  }

  ctx.putImageData(imageData, 0, 0);
  return output;
}

function sampleAverageColor(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { r: number; g: number; b: number } {
  const pad = 2;
  const sx0 = Math.max(0, x0 - pad);
  const sy0 = Math.max(0, y0 - pad);
  const sx1 = Math.min(width, x1 + pad);
  const sy1 = Math.min(height, y1 + pad);

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let y = sy0; y < sy1; y++) {
    for (let x = sx0; x < sx1; x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const idx = (y * width + x) * 4;
      r += pixels[idx];
      g += pixels[idx + 1];
      b += pixels[idx + 2];
      count++;
    }
  }

  if (count === 0) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        r += pixels[idx];
        g += pixels[idx + 1];
        b += pixels[idx + 2];
        count++;
      }
    }
  }

  if (count === 0) {
    return { r: 255, g: 255, b: 255 };
  }

  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
  };
}

function fillRect(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: { r: number; g: number; b: number },
): void {
  const startX = Math.max(0, x0);
  const startY = Math.max(0, y0);
  const endX = Math.min(width, x1);
  const endY = Math.min(height, y1);

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const idx = (y * width + x) * 4;
      pixels[idx] = color.r;
      pixels[idx + 1] = color.g;
      pixels[idx + 2] = color.b;
      pixels[idx + 3] = 255;
    }
  }
}

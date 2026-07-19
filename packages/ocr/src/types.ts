/**
 * OCR result types. Coordinates are in source-image pixels.
 */

export interface OcrBlock {
  text: string;
  bbox: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };
  confidence: number;
}

export interface OcrResult {
  text: string;
  blocks: OcrBlock[];
}

export interface OcrProgress {
  status: string;
  progress: number;
}

export interface OcrOptions {
  lang?: string;
  onProgress?: (p: OcrProgress) => void;
}

import type { OcrBlock, OcrOptions, OcrProgress, OcrResult } from "./types.js";

type LoggerMessage = {
  status: string;
  progress: number;
};

type WorkerLike = {
  setParameters: (params: Record<string, unknown>) => Promise<void>;
  recognize: (
    source: string | Blob | URL,
    options?: Record<string, unknown>,
    config?: { logger?: (m: LoggerMessage) => void },
  ) => Promise<{ data: unknown }>;
  terminate: () => Promise<void>;
};

type TesseractModule = {
  createWorker: (lang?: string | string[]) => Promise<WorkerLike>;
};

/**
 * Run OCR on an image source using a lazy-loaded tesseract.js worker.
 *
 * The tesseract.js module is only imported when this function is called,
 * so hosts that do not use OCR avoid the WASM/worker startup cost.
 */
export async function ocrImage(
  source: string | Blob | URL,
  opts: OcrOptions = {},
): Promise<OcrResult> {
  const Tesseract = (await import("tesseract.js")) as unknown as TesseractModule;
  const worker = await Tesseract.createWorker(opts.lang ?? "eng");

  try {
    await worker.setParameters({});
    const { data } = await worker.recognize(source, {}, {
      logger: (m) => {
        opts.onProgress?.({ status: m.status, progress: m.progress });
      },
    });
    await worker.terminate();
    return formatOcrResult(data);
  } catch (err) {
    await worker.terminate().catch(() => undefined);
    throw new Error(
      `OCR failed${err instanceof Error ? `: ${err.message}` : ""}`,
      { cause: err },
    );
  }
}

/**
 * Convert raw tesseract.js output into a stable OcrResult shape.
 * Falls back to an empty result when the input is malformed.
 */
export function formatOcrResult(data: unknown): OcrResult {
  if (!data || typeof data !== "object") {
    return { text: "", blocks: [] };
  }
  const d = data as Record<string, unknown>;
  const text = typeof d.text === "string" ? d.text : "";

  const blocks: OcrBlock[] = [];
  if (Array.isArray(d.blocks)) {
    for (const raw of d.blocks) {
      const block = parseBlock(raw);
      if (block) blocks.push(block);
    }
  } else if (Array.isArray(d.words)) {
    for (const raw of d.words) {
      const block = parseWord(raw);
      if (block) blocks.push(block);
    }
  }

  return { text, blocks };
}

function parseBlock(raw: unknown): OcrBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const text = typeof b.text === "string" ? b.text : "";
  if (text === "") return null;
  const bbox = parseBbox(b.bbox);
  if (!bbox) return null;
  const confidence = typeof b.confidence === "number" ? b.confidence : 0;
  return { text, bbox, confidence };
}

function parseWord(raw: unknown): OcrBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const text = typeof w.text === "string" ? w.text : "";
  if (text === "") return null;
  const bbox = parseBbox(w.bbox);
  if (!bbox) return null;
  const confidence = typeof w.confidence === "number" ? w.confidence : 0;
  return { text, bbox, confidence };
}

function parseBbox(raw: unknown): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const bb = raw as Record<string, unknown>;
  if (
    typeof bb.x0 === "number" &&
    typeof bb.y0 === "number" &&
    typeof bb.x1 === "number" &&
    typeof bb.y1 === "number"
  ) {
    return { x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1 };
  }
  return null;
}

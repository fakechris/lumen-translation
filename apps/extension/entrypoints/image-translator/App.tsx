import { useState, useRef } from "react";
import type { Settings } from "@lumen/core";
import { useSettings } from "../../src/store";
import { buildEngine } from "../../src/engines";
import { t } from "../../src/i18n";

export default function App() {
  const settings = useSettings();
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<{ original: string; translated: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<File | null>(null);

  const handleFile = (f: File) => {
    setError(null);
    setResult(null);
    fileRef.current = f;
    if (imgUrl) URL.revokeObjectURL(imgUrl);
    setImgUrl(URL.createObjectURL(f));
  };

  const run = async () => {
    if (!fileRef.current) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress("Loading OCR engine…");
    try {
      // Dynamic import so tesseract.js + WASM only load when the user actually
      // translates an image. The OCR worker path is auto-resolved by tesseract.js.
      const { ocrAndTranslate } = await import("@lumen/ocr");
      const engine = buildEngine(settings as Settings);
      const out = await ocrAndTranslate(
        imgUrl!,
        engine,
        { source: settings.sourceLang, target: settings.targetLang },
        {
          lang: detectOcrLang(settings.targetLang),
          onProgress: (p) => setProgress(`${p.status} ${Math.round((p.progress ?? 0) * 100)}%`),
          glossary: settings.glossary,
          concurrency: settings.concurrency,
        },
      );
      setResult({ original: out.original.text, translated: out.translated });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div
      className="max-w-3xl mx-auto p-6 space-y-5"
      style={{
        background: 'var(--lumen-bg)',
        color: 'var(--lumen-text)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        minHeight: '100vh',
      }}
    >
      <header>
        <h1 className="text-2xl font-semibold" style={{ letterSpacing: '-0.02em' }}>
          {t('app.name')} · Image Translator
        </h1>
        <p className="text-sm" style={{ color: 'var(--lumen-muted)' }}>
          OCR + translation, runs locally via Tesseract.js. No image leaves your device.
        </p>
      </header>

      <label
        className="block border-2 border-dashed rounded-lg p-6 text-center cursor-pointer"
        style={{ borderRadius: 16, borderColor: 'var(--lumen-border-strong)' }}
      >
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        {imgUrl ? (
          <img src={imgUrl} alt="source" className="max-h-60 mx-auto rounded" />
        ) : (
          <div style={{ color: 'var(--lumen-muted)' }}>Click to choose an image (PNG / JPG / WebP)</div>
        )}
      </label>

      {imgUrl && (
        <button
          className="lumen-btn-primary px-4 py-2 text-sm disabled:opacity-50"
          onClick={run}
          disabled={busy}
        >
          {busy ? (progress ?? 'Working…') : 'OCR + Translate'}
        </button>
      )}

      {error && (
        <div
          className="border rounded p-3 text-sm"
          style={{
            background: 'var(--lumen-danger-soft)',
            color: 'var(--lumen-danger)',
            borderColor: 'var(--lumen-danger)',
            borderRadius: 10,
          }}
        >
          {error}
        </div>
      )}

      {result && (
        <div className="lumen-card p-5 space-y-3">
          <div>
            <div className="text-xs mb-1" style={{ color: 'var(--lumen-muted)' }}>
              OCR text
            </div>
            <pre className="text-sm whitespace-pre-wrap font-sans">{result.original}</pre>
          </div>
          <div>
            <div className="text-xs mb-1" style={{ color: 'var(--lumen-muted)' }}>
              Translation
            </div>
            <p
              className="text-sm pl-3"
              style={{ borderLeft: '3px solid var(--lumen-accent)' }}
            >
              {result.translated}
            </p>
          </div>
          <button
            className="text-xs hover:underline"
            style={{ color: 'var(--lumen-accent-2)' }}
            onClick={() => navigator.clipboard.writeText(result.translated)}
          >
            copy translation
          </button>
        </div>
      )}
    </div>
  );
}

/** Pick a Tesseract language pack from the target language. */
function detectOcrLang(target: string): string {
  if (target.startsWith("zh")) return "chi_sim+eng";
  if (target.startsWith("ja")) return "jpn";
  if (target.startsWith("ko")) return "kor";
  if (target.startsWith("ar")) return "ara";
  return "eng";
}

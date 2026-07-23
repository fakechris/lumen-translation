import { useState, useRef } from "react";
import type { Settings } from "@lumen/core";
import { useSettings } from "../../src/store";
import { buildEngine } from "../../src/engines";
import { t } from "../../src/i18n";

export default function App() {
  const settings = useSettings();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState<number>(0);
  const fileRef = useRef<File | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const handleFile = (f: File) => {
    fileRef.current = f;
    setError(null);
    setPageCount(0);
    if (containerRef.current) containerRef.current.innerHTML = "";
  };

  const run = async () => {
    if (!fileRef.current) return;
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: 0 });
    try {
      // Dynamic import so pdf.js + WASM only load when translating a PDF.
      const { loadPdf, translatePdf, renderBilingualPdf } = await import("@lumen/pdf");
      // Bundle the pdf.js worker via Vite's ?url import.
      const workerMod = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      const data = await fileRef.current.arrayBuffer();
      const { pages, numPages } = await loadPdf(data, { workerSrc: workerMod.default });
      setPageCount(numPages);
      setProgress({ done: 0, total: pages.length });
      const engine = buildEngine(settings as Settings);
      const translated = await translatePdf(pages, engine, {
        source: settings.sourceLang,
        target: settings.targetLang,
      } as never, {
        glossary: settings.glossary,
        concurrency: settings.concurrency,
        maxBatchSize: settings.maxBatchSize,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      if (containerRef.current) {
        renderBilingualPdf(translated, containerRef.current, {
          bilingual: settings.bilingual,
          style: settings.style,
        });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="max-w-4xl mx-auto p-6 space-y-5"
      style={{
        background: 'var(--lumen-bg)',
        color: 'var(--lumen-text)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        minHeight: '100vh',
      }}
    >
      <header>
        <h1 className="text-2xl font-semibold" style={{ letterSpacing: '-0.02em' }}>
          {t('app.name')} · PDF Translator
        </h1>
        <p className="text-sm" style={{ color: 'var(--lumen-muted)' }}>
          Reflow bilingual PDF — original text + translation per paragraph. Runs locally via pdf.js.
        </p>
      </header>

      <label
        className="block border-2 border-dashed rounded-lg p-6 text-center cursor-pointer"
        style={{ borderRadius: 16, borderColor: 'var(--lumen-border-strong)' }}
      >
        <input
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        {fileRef.current ? (
          <div>
            <div className="font-medium">{fileRef.current.name}</div>
            <div className="text-xs mt-1" style={{ color: 'var(--lumen-muted)' }}>
              click to choose another PDF
            </div>
          </div>
        ) : (
          <div style={{ color: 'var(--lumen-muted)' }}>Drop or click to choose a PDF</div>
        )}
      </label>

      {fileRef.current && (
        <button
          className="lumen-btn-primary px-4 py-2 text-sm disabled:opacity-50"
          onClick={run}
          disabled={busy}
        >
          {busy ? 'Translating…' : 'Translate PDF'}
        </button>
      )}

      {progress && progress.total > 0 && (
        <div className="text-xs" style={{ color: 'var(--lumen-muted)' }}>
          {progress.done}/{progress.total} pages
        </div>
      )}
      {pageCount > 0 && !busy && (
        <div className="text-xs" style={{ color: 'var(--lumen-muted)' }}>
          {pageCount} pages loaded
        </div>
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

      <div
        ref={containerRef}
        className="lumen-card p-6 max-h-[75vh] overflow-auto prose prose-sm max-w-none"
      />

      <style>{`
        .lumen-pdf-page { margin-bottom: 2em; padding-bottom: 1em; border-bottom: 1px solid #e7e1d8; }
        .lumen-pdf-translation { margin: .25em 0 .5em; padding: .25em .5em; border-left: 3px solid #9f4f24; background: #f4dfd2; color: #1f1a17; }
        .lumen-pdf-translation[data-lumen-style="green"] { border-left-color: #2f7d52; background: rgba(47, 125, 82, 0.10); }
        .lumen-pdf-translation[data-lumen-style="plain"] { border-left: none; background: transparent; border-top: 1px dashed #cdc4b6; }
        .lumen-pdf-translation[data-lumen-style="minimal"] { border-left: none; background: transparent; padding: 0; }
      `}</style>
    </div>
  );
}

import { useState, useCallback } from "react";
import { translateAll, dedupeSegments, escapeHtml, type Segment, type Settings } from "@lumen/core";
import { useSettings } from "../../src/store";
import { buildEngine } from "../../src/engines";
import { t } from "../../src/i18n";

interface Block {
  id: string;
  html: string;
  text: string;
  translated?: string;
}

export default function App() {
  const settings = useSettings();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [filename, setFilename] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setBlocks([]);
    setFilename(file.name);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const text = await file.text();
      let parsed: Block[] = [];
      if (ext === "epub") {
        parsed = await parseEpub(file);
      } else if (ext === "html" || ext === "htm") {
        parsed = parseHtml(text);
      } else if (ext === "md" || ext === "markdown") {
        parsed = parseMarkdown(text);
      } else {
        parsed = parseTxt(text);
      }
      setBlocks(parsed);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const translate = useCallback(async () => {
    if (blocks.length === 0) return;
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: blocks.length });
    try {
      const engine = buildEngine(settings as Settings);
      const segments: Segment[] = blocks.map((b) => ({ id: b.id, text: b.text }));
      const { unique, restore } = dedupeSegments(segments);
      const result = await translateAll(
        engine,
        {
          pair: { source: settings.sourceLang, target: settings.targetLang },
          segments: unique,
          glossary: settings.glossary,
        },
        { concurrency: settings.concurrency, maxBatchSize: settings.maxBatchSize },
      );
      const out = restore(result.segments);
      const byId = new Map(out.map((s) => [s.id, s.text]));
      setBlocks((prev) => prev.map((b) => ({ ...b, translated: byId.get(b.id) ?? b.text })));
      setProgress({ done: blocks.length, total: blocks.length });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [blocks, settings]);

  const download = (kind: "txt" | "md" | "html") => {
    const content = serialize(blocks, kind, settings.bilingual);
    const blob = new Blob([content], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.replace(/\.[^.]+$/, "") + `.bilingual.${kind}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-5">
      <header>
        <h1 className="text-2xl font-bold">{t("app.name")} · File Translator</h1>
        <p className="text-sm text-gray-500">TXT · Markdown · HTML · ePub — bilingual output, fully local.</p>
      </header>

      <DropZone onFile={handleFile} filename={filename} />

      {error && <div className="bg-red-50 text-red-700 border border-red-200 rounded p-3 text-sm">{error}</div>}

      {blocks.length > 0 && (
        <div className="flex flex-wrap gap-2 items-center">
          <button
            className="bg-blue-600 text-white rounded px-4 py-2 text-sm hover:bg-blue-700 disabled:opacity-50"
            onClick={translate}
            disabled={busy}
          >
            {busy ? "Translating…" : `Translate ${blocks.length} blocks`}
          </button>
          {progress && (
            <span className="text-xs text-gray-500">
              {progress.done}/{progress.total}
            </span>
          )}
          <div className="flex-1" />
          <button className="border rounded px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => download("txt")} disabled={busy}>
            ↓ TXT
          </button>
          <button className="border rounded px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => download("md")} disabled={busy}>
            ↓ MD
          </button>
          <button className="border rounded px-3 py-1.5 text-sm hover:bg-gray-50" onClick={() => download("html")} disabled={busy}>
            ↓ HTML
          </button>
        </div>
      )}

      {blocks.length > 0 && (
        <div className="bg-white rounded-lg shadow-sm p-5 space-y-3 max-h-[70vh] overflow-auto">
          {blocks.map((b) => (
            <div key={b.id} className="border-b last:border-b-0 pb-3">
              <div
                className="prose prose-sm max-w-none"
                // Safe: every block's `html` is sanitized at parse time.
                // TXT/Markdown blocks are built from escapeHtml (fully escaped).
                // HTML/ePub blocks are run through `sanitizeHtml` (DOMParser-based)
                // which strips <script>/<style>/<iframe>/..., on* event handlers,
                // and javascript:/vbscript:/data: URIs in href/src. See parsers.
                dangerouslySetInnerHTML={{ __html: b.html }}
              />
              {b.translated !== undefined && (
                <p className="mt-2 border-l-3 border-blue-600 pl-3 text-gray-800">{b.translated}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DropZone({ onFile, filename }: { onFile: (f: File) => void; filename: string }) {
  const [drag, setDrag] = useState(false);
  return (
    <label
      className={`block border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition ${
        drag ? "border-blue-600 bg-blue-50" : "border-gray-300 hover:border-gray-400"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
    >
      <input
        type="file"
        className="hidden"
        accept=".txt,.md,.markdown,.html,.htm,.epub"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
      {filename ? (
        <div>
          <div className="font-medium">{filename}</div>
          <div className="text-xs text-gray-500 mt-1">click or drop another file to replace</div>
        </div>
      ) : (
        <div>
          <div className="font-medium">Drop a file here or click to choose</div>
          <div className="text-xs text-gray-500 mt-1">TXT · MD · HTML · ePub</div>
        </div>
      )}
    </label>
  );
}

// ---------- parsers ----------

function parseTxt(text: string): Block[] {
  return text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text, i) => ({
      id: `b${i}`,
      html: escapeHtml(text).replace(/\n/g, "<br/>"),
      text,
    }));
}

function parseMarkdown(text: string): Block[] {
  // Split by blank lines; preserve heading markers in both html and text.
  return text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw, i) => {
      const isHeading = /^#{1,6}\s/.test(raw);
      const html = isHeading
        ? `<strong>${escapeHtml(raw)}</strong>`
        : `<p>${escapeHtml(raw).replace(/\n/g, "<br/>")}</p>`;
      return { id: `b${i}`, html, text: raw.replace(/^#{1,6}\s+/, "") };
    });
}

function parseHtml(text: string): Block[] {
  const doc = new DOMParser().parseFromString(text, "text/html");
  // Pull block-level elements in document order.
  const selector = "p, h1, h2, h3, h4, h5, h6, li, blockquote, td, figcaption, article, section";
  const nodes = Array.from(doc.querySelectorAll(selector));
  const seen = new WeakSet<Element>();
  const blocks: Block[] = [];
  let i = 0;
  for (const el of nodes) {
    if (seen.has(el)) continue;
    // Skip if an ancestor block is already going to be captured.
    let p = el.parentElement;
    let skip = false;
    while (p) {
      if (seen.has(p)) {
        skip = true;
        break;
      }
      p = p.parentElement;
    }
    if (skip) continue;
    seen.add(el);
    const t = (el.textContent ?? "").trim();
    if (!t) continue;
    blocks.push({ id: `b${i++}`, html: sanitizeHtml(el.outerHTML), text: t });
  }
  if (blocks.length === 0) {
    // Fallback: whole body text.
    const body = doc.body?.textContent ?? text;
    return parseTxt(body);
  }
  return blocks;
}

async function parseEpub(file: File): Promise<Block[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  // Find the OPF file from META-INF/container.xml
  const containerXml = await zip.file("META-INF/container.xml")?.async("string");
  if (!containerXml) throw new Error("Invalid ePub: no META-INF/container.xml");
  const opfPath = new DOMParser()
    .parseFromString(containerXml, "application/xml")
    .querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath) throw new Error("Invalid ePub: no rootfile in container.xml");
  const opfXml = await zip.file(opfPath)?.async("string");
  if (!opfXml) throw new Error("Invalid ePub: OPF missing");
  const opf = new DOMParser().parseFromString(opfXml, "application/xml");
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  // Read spine itemrefs in order.
  const idHref = new Map<string, string>();
  opf.querySelectorAll("manifest > item").forEach((item) => {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) idHref.set(id, href);
  });
  const spineIds = Array.from(opf.querySelectorAll("spine > itemref"))
    .map((r) => r.getAttribute("idref") ?? "")
    .filter(Boolean);
  const blocks: Block[] = [];
  let i = 0;
  for (const id of spineIds) {
    const href = idHref.get(id);
    if (!href) continue;
    const path = opfDir + href;
    const html = await zip.file(path)?.async("string");
    if (!html) continue;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const selector = "p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption";
    doc.querySelectorAll(selector).forEach((el) => {
      const text = (el.textContent ?? "").trim();
      if (!text) return;
      blocks.push({ id: `b${i++}`, html: sanitizeHtml(el.outerHTML), text });
    });
  }
  return blocks;
}

// ---------- serializer ----------

function serialize(blocks: Block[], kind: "txt" | "md" | "html", bilingual: boolean): string {
  if (kind === "txt") {
    return blocks
      .map((b) => (bilingual ? `${b.text}\n\n${b.translated ?? ""}` : b.translated ?? b.text))
      .join("\n\n---\n\n");
  }
  if (kind === "md") {
    return blocks
      .map((b) => (bilingual ? `**原文 / Original:**\n\n${b.text}\n\n**译文 / Translation:**\n\n${b.translated ?? ""}` : b.translated ?? b.text))
      .join("\n\n---\n\n");
  }
  const body = blocks
    .map(
      (b) =>
        `<div class="lumen-block"><div class="lumen-original">${b.html}</div>` +
        (bilingual ? `<div class="lumen-translation">${escapeHtml(b.translated ?? "")}</div>` : "") +
        `</div>`,
    )
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
.lumen-block{margin:0 0 1em;padding:0 0 1em;border-bottom:1px solid #eee}
.lumen-translation{margin-top:.5em;padding:.25em .5em;border-left:3px solid #2563eb;background:rgba(37,99,235,.05);color:#111}
</style></head><body>${body}</body></html>`;
}

/**
 * Sanitize untrusted HTML (from uploaded .html/.htm/.epub files) before it
 * reaches `dangerouslySetInnerHTML`. Uses DOMParser so no new dependency is
 * introduced — the extension already runs in a DOM environment.
 *
 * Strips:
 *   - <script>, <style>, <iframe>, <object>, <embed>, <link>, <meta>,
 *     <base>, <form> elements (removed entirely, including descendants).
 *   - Any attribute whose name starts with `on` (event handlers like
 *     onclick, onerror, onmouseover, ...).
 *   - javascript:/vbscript:/data: URIs in href, src, xlink:href, formaction,
 *     and similar URL-bearing attributes.
 *
 * The returned string is the sanitized innerHTML of a fresh <body>; it is
 * safe to assign via `dangerouslySetInnerHTML`.
 */
function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;

  // Remove disallowed elements entirely (descendants go with them).
  body
    .querySelectorAll("script, style, iframe, object, embed, link, meta, base, form")
    .forEach((el) => el.remove());

  // Strip dangerous attributes from every remaining element.
  const urlAttrs = new Set(["href", "src", "xlink:href", "formaction", "action", "poster", "background", "cite"]);
  body.querySelectorAll("*").forEach((el) => {
    // Clone attributes list so removal during iteration is safe.
    Array.from(el.attributes).forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        return;
      }
      if (urlAttrs.has(name)) {
        const value = attr.value.trim().toLowerCase().replace(/^[\s\n\r\t]+/, "");
        // Strip whitespace/control chars then block dangerous URI schemes.
        if (
          value.startsWith("javascript:") ||
          value.startsWith("vbscript:") ||
          value.startsWith("data:")
        ) {
          el.removeAttribute(attr.name);
        }
      }
    });
  });

  return body.innerHTML;
}

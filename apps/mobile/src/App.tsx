import { useState } from "react";
import { translateAll, type Segment } from "@lumen/core";
import {
  createGoogleEngine,
  createProviderEngine,
  createOpenAIEngine,
} from "@lumen/engines";

/**
 * Lumen mobile shell — a minimal text translator that reuses the same
 * @lumen/core + @lumen/engines packages as the browser extension. This proves
 * the core is runtime-portable; a full mobile UI (camera OCR, webview bilingual
 * translation) can be layered on top.
 */

const ENGINES = [
  { id: "google", label: "Google (free)" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "glm", label: "GLM 智谱" },
  { id: "kimi", label: "Kimi" },
  { id: "qwen", label: "通义千问" },
  { id: "openai", label: "OpenAI / Compatible" },
];

export default function App() {
  const [text, setText] = useState("");
  const [target, setTarget] = useState("zh");
  const [source, setSource] = useState("auto");
  const [engineId, setEngineId] = useState("google");
  const [apiKey, setApiKey] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    setResult("");
    try {
      let engine;
      if (engineId === "google") engine = createGoogleEngine();
      else if (engineId === "openai")
        engine = createOpenAIEngine({ apiKey: apiKey || undefined, model: "gpt-4o-mini" });
      else engine = createProviderEngine(engineId, { apiKey: apiKey || undefined });
      if (!engine) throw new Error("unknown engine");
      const seg: Segment = { id: "m", text };
      const r = await translateAll(
        engine,
        { pair: { source, target }, segments: [seg] },
        { concurrency: 4, maxBatchSize: 16 },
      );
      setResult(r.segments[0]?.text ?? text);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <h1>Lumen Translation</h1>
      <p className="muted">Open-source bilingual translation · Apache-2.0</p>

      <textarea
        placeholder="Type or paste text to translate…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <div className="row">
        <select value={engineId} onChange={(e) => setEngineId(e.target.value)} style={{ flex: 1 }}>
          {ENGINES.map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
        </select>
        <input
          placeholder="target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          style={{ width: 80 }}
        />
        <input
          placeholder="source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          style={{ width: 80 }}
        />
      </div>

      {engineId !== "google" && (
        <input
          type="password"
          placeholder="API key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      )}

      <button className="primary" onClick={run} disabled={busy}>
        {busy ? "Translating…" : "Translate"}
      </button>

      {error && <div className="result" style={{ borderLeftColor: 'var(--lumen-danger)' }}>{error}</div>}
      {result && <div className="result">{result}</div>}
    </div>
  );
}

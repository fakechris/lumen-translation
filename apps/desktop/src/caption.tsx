// Live-subtitle overlay. Renders the two-pass caption pipeline:
//   caption-partial — tentative original (lighter, italic), never translated
//   caption-final   — committed caption piece (utterance + seq)
//   caption-refine  — Whisper's re-transcription of a whole utterance;
//                     collapses that utterance's pieces back into one line
//
// Translation is final-only and settles first: each line schedules its
// translation after a short grace window, so a Whisper refine that lands
// within the window is what gets translated (and shown), not the throwaway
// pass-1 text. Engine routing/fallback reuses translate() — the same module
// the translate window uses — so provider settings apply unchanged.
import "./styles.css";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";
import { loadSettings, type Settings } from "./settings";
import { translate, TranslationFailed } from "./translate";

interface CaptionEvent {
  revision: number;
  utterance: number;
  seq: number;
  appName: string;
  text: string;
  isFinal: boolean;
}

interface CaptionRefineEvent {
  utterance: number;
  appName: string;
  text: string;
}

interface CaptionLine {
  key: string;
  utterance: number;
  text: string;
  translation?: string;
}

/** Grace window before a final is translated — lets the Whisper refine land. */
const TRANSLATE_SETTLE_MS = 1500;
/** Lines kept on screen (older fade out via the first-child opacity rule). */
const VISIBLE_LINES = 2;

function CaptionOverlay() {
  const [lines, setLines] = useState<CaptionLine[]>([]);
  const [partial, setPartial] = useState("");
  const [appName, setAppName] = useState("");
  const [error, setError] = useState("");
  const settingsRef = useRef<Settings | null>(null);
  const lastRevision = useRef(0);

  useEffect(() => {
    loadSettings()
      .then((s) => {
        settingsRef.current = s;
      })
      .catch(() => setError("settings unavailable — captions only, no translation"));

    const translateLine = (key: string, text: string) => {
      const settings = settingsRef.current;
      if (!settings || !text.trim()) return;
      translate(text, settings)
        .then((result) => {
          setLines((current) =>
            current.map((l) => (l.key === key ? { ...l, translation: result.translation } : l)),
          );
        })
        .catch((err) => {
          if (!(err instanceof TranslationFailed)) console.warn("[caption] translate failed", err);
        });
    };

    const unlisteners: Promise<() => void>[] = [
      listen<CaptionEvent>("caption-partial", (e) => {
        if (e.payload.revision < lastRevision.current) return;
        lastRevision.current = e.payload.revision;
        setAppName(e.payload.appName);
        setPartial(e.payload.text);
      }),
      listen<CaptionEvent>("caption-final", (e) => {
        if (e.payload.revision < lastRevision.current) return;
        lastRevision.current = e.payload.revision;
        setAppName(e.payload.appName);
        setPartial("");
        const { utterance, seq, text } = e.payload;
        const key = `${utterance}-${seq}`;
        setLines((current) => [...current.slice(-(VISIBLE_LINES - 1)), { key, utterance, text }]);
        // Final-only translation, after the refine grace window. Re-reads the
        // line's text at fire time so a refine within the window wins.
        window.setTimeout(() => {
          setLines((current) => {
            const line = current.find((l) => l.key === key);
            if (line && !line.translation) translateLine(key, line.text);
            return current;
          });
        }, TRANSLATE_SETTLE_MS);
      }),
      listen<CaptionRefineEvent>("caption-refine", (e) => {
        setLines((current) => {
          const affected = current.filter((l) => l.utterance === e.payload.utterance);
          if (affected.length === 0) return current;
          // Collapse the utterance's pieces into one refined line; keep its
          // translation only when the refine was in time (text unchanged).
          const translation = affected[0].text === e.payload.text
            ? affected[0].translation
            : undefined;
          const refined: CaptionLine = {
            key: `${e.payload.utterance}-r`,
            utterance: e.payload.utterance,
            text: e.payload.text,
            translation,
          };
          const others = current.filter((l) => l.utterance !== e.payload.utterance);
          const merged = [...others, refined];
          if (!translation) translateLine(refined.key, e.payload.text);
          return merged.slice(-VISIBLE_LINES);
        });
      }),
      listen<string>("caption-error", (e) => setError(e.payload)),
      listen<string>("caption-target", (e) => setAppName(e.payload)),
    ];
    return () => {
      for (const p of unlisteners) p.then((f) => f());
    };
  }, []);

  return (
    <div className="caption-overlay">
      <div className="caption-hint">
        {error ? error : partial ? `听 ${appName}…` : appName ? appName : "starting…"}
      </div>
      <div className="caption-lines">
        {lines.map((line) => (
          <div key={line.key} className="caption-block">
            <div className="caption-line translation">{line.translation ?? "…"}</div>
            <div className="caption-line original">{line.text}</div>
          </div>
        ))}
        {partial && (
          <div className="caption-line partial">
            {lines.length === 0 ? "" : ""}
            {partial}
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CaptionOverlay />
  </StrictMode>,
);

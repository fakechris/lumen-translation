// Live-subtitle overlay (Spike 1). One job: render caption events from the
// Rust tap→Paraformer pipeline. Partials render tentative (lighter, italic);
// finals commit as history lines and old ones fade out. No provider calls —
// translation is Spike 2.
import "./styles.css";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { listen } from "@tauri-apps/api/event";

interface CaptionEvent {
  revision: number;
  appName: string;
  text: string;
  isFinal: boolean;
}

const HISTORY = 2;

function CaptionOverlay() {
  const [history, setHistory] = useState<string[]>([]);
  const [partial, setPartial] = useState("");
  const [appName, setAppName] = useState("");
  const [error, setError] = useState("");
  // Track the highest revision seen so a stale delivery after a faster one
  // never moves the UI backwards.
  const lastRevision = useRef(0);

  useEffect(() => {
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
        setHistory((h) => [...h.slice(-(HISTORY - 1)), e.payload.text]);
      }),
      listen<string>("caption-error", (e) => setError(e.payload)),
      listen<string>("caption-target", (e) => setAppName(e.payload)),
    ];
    return () => {
      for (const p of unlisteners) p.then((f) => f());
    };
  }, []);

  const lines = [...history, partial].filter(Boolean);
  return (
    <div className="caption-overlay">
      <div className="caption-hint">
        {error ? error : partial ? `听 ${appName}…` : appName ? appName : "starting…"}
      </div>
      <div className="caption-lines">
        {lines.map((text, i) => {
          const isPartial = i === lines.length - 1 && partial !== "";
          return (
            <div key={`${i}-${text.slice(0, 8)}`} className={isPartial ? "caption-line partial" : "caption-line"}>
              {text}
            </div>
          );
        })}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CaptionOverlay />
  </StrictMode>,
);

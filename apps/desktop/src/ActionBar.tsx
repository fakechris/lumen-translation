/**
 * The selection action bar — Lumen's stand-in for PopClip on Windows.
 *
 * Rust detects the selection gesture, positions this window just above the
 * cursor and shows it; all this component does is render the affordance and
 * hand the click back to Rust, which resolves the selected text (UI Automation
 * first, synthesised Ctrl+C second) and routes it to the translation window.
 *
 * The window is `WS_EX_NOACTIVATE`, so clicking here never takes focus away
 * from the app the user selected text in.
 */

import { invoke } from "@tauri-apps/api/core";
import { LumenIcon } from "./Icons";

export function ActionBar() {
  const onTranslate = () => {
    // Fire-and-forget: Rust hides the bar and drives the translation window.
    void invoke("translate_selection").catch(console.error);
  };

  return (
    <div className="bar">
      <button onMouseDown={onTranslate} title="Translate with Lumen">
        <LumenIcon />
        Lumen
      </button>
    </div>
  );
}

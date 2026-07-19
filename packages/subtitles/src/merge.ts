/**
 * Merge adjacent short cues to reduce flicker and on-screen churn.
 *
 * Two adjacent cues are merged when *both* constraints hold:
 *   - the combined duration (start of first → end of last) is ≤ `maxDuration`
 *   - the combined character count (sum of `text.length`) is ≤ `maxChars`
 *
 * Merged cues keep the start of the first cue and the end of the last cue;
 * text is joined with `\n`.
 */

import type { SubtitleCue } from "./types.js";

export interface MergeOptions {
  /** Maximum combined duration in seconds. Default 5. */
  maxDuration?: number;
  /** Maximum combined character count. Default 80. */
  maxChars?: number;
}

const DEFAULT_MAX_DURATION = 5;
const DEFAULT_MAX_CHARS = 80;

export function mergeShortCues(cues: SubtitleCue[], opts: MergeOptions = {}): SubtitleCue[] {
  const maxDuration = opts.maxDuration ?? DEFAULT_MAX_DURATION;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  if (cues.length === 0) return [];

  const out: SubtitleCue[] = [];
  let current: SubtitleCue = { ...cues[0] };

  for (let i = 1; i < cues.length; i++) {
    const next = cues[i];
    const combinedDuration = next.end - current.start;
    const combinedChars = current.text.length + 1 + next.text.length; // +1 for `\n`

    if (combinedDuration <= maxDuration && combinedChars <= maxChars) {
      current = {
        id: current.id,
        start: current.start,
        end: next.end,
        text: `${current.text}\n${next.text}`,
      };
    } else {
      out.push(current);
      current = { ...next };
    }
  }
  out.push(current);
  return out;
}

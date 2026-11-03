/**
 * Chain-of-thought scrubbing.
 *
 * Reasoning models (and the ones whose "disable thinking" knob the provider
 * doesn't implement) stream their scratchpad inside `<think>…</think>`
 * before the actual answer. That scratchpad is not a translation: it is the
 * model thinking out loud, often in a different language, and it must never
 * reach the user's translation pane.
 */

/** A closed reasoning block. */
const CLOSED_THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;

/** An opening tag whose block has not been closed yet. */
const OPEN_THINK_TAG = /<think>/i;

/** Any reasoning tag, in any casing — used as a cheap pre-check. */
const ANY_THINK_TAG = /<\/?think>/i;

/**
 * Remove reasoning blocks from a model's output.
 *
 * The function is incremental-friendly: an *unterminated* `<think>` block —
 * the model is still writing it — is dropped as well, so a streaming caller
 * that re-strips the accumulated text on every chunk never shows a
 * half-written reasoning block.
 *
 * @example
 * stripThinkingTags("<think>hmm</think>你好") // => "你好"
 * stripThinkingTags("<think>still going")     // => ""
 */
export function stripThinkingTags(text: string): string {
  if (!text) return text;
  if (!ANY_THINK_TAG.test(text)) return text;
  let out = text.replace(CLOSED_THINK_BLOCK, "");
  const open = out.search(OPEN_THINK_TAG);
  if (open >= 0) out = out.slice(0, open);
  return out;
}

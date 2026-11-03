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

/** The body of the opening tag — what follows the "<". */
const OPEN_TAG_BODY = "think";

export interface StripThinkingTagsOptions {
  /**
   * Hold back a trailing partial opening tag.
   *
   * A provider can split `<think>` across content deltas, so the accumulator
   * can momentarily hold "<thi". Emitting that would put reasoning markup in
   * the translation pane for a moment. With this on, the partial prefix is
   * withheld until later content shows whether it completes the tag.
   */
  holdPartialTag?: boolean;
}

/**
 * Drop a trailing partial opening tag, if the text ends with one.
 *
 * Only a *prefix* of the tag body counts ("t", "th", "thi", "think"): a lone
 * "<" is ordinary text and stays.
 */
function splitPartialOpenTag(text: string): string {
  const lt = text.lastIndexOf("<");
  if (lt < 0) return text;
  const tail = text.slice(lt + 1);
  if (tail.length === 0 || tail.length > OPEN_TAG_BODY.length) return text;
  if (
    OPEN_TAG_BODY.slice(0, tail.length).toLowerCase() !== tail.toLowerCase()
  ) {
    return text;
  }
  return text.slice(0, lt);
}

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
export function stripThinkingTags(
  text: string,
  opts: StripThinkingTagsOptions = {},
): string {
  if (!text) return text;
  let out = text;
  if (ANY_THINK_TAG.test(out)) {
    out = out.replace(CLOSED_THINK_BLOCK, "");
    const open = out.search(OPEN_THINK_TAG);
    if (open >= 0) out = out.slice(0, open);
  }
  if (opts.holdPartialTag) out = splitPartialOpenTag(out);
  return out;
}

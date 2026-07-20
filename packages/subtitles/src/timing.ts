/**
 * Shared subtitle timing utilities.
 *
 * Timing helpers are used by both heuristic and AI-based cue splitters.
 */

/** Distribute `total` seconds across `parts` proportionally to their weights. */
export function proportionalTimings(
  start: number,
  end: number,
  weights: number[],
): Array<{ start: number; end: number }> {
  const total = Math.max(0, end - start);
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  const out: Array<{ start: number; end: number }> = [];
  let cursor = start;
  for (let i = 0; i < weights.length; i++) {
    const dur = (weights[i] / totalWeight) * total;
    const segEnd = i === weights.length - 1 ? end : cursor + dur;
    out.push({ start: cursor, end: segEnd });
    cursor = segEnd;
  }
  return out;
}

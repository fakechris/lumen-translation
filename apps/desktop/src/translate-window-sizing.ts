/**
 * Sizing rules for the translate window's card.
 *
 * The card grows to fit its content, but each text pane is capped so that a
 * long selection scrolls inside the card instead of producing a window taller
 * than the display. The caps are a share of the display's *work area* — a
 * constant that does not depend on the window's own height.
 *
 * That distinction is the whole point. The previous implementation capped the
 * panes in `vh` and measured the *capped* height (`clientHeight`), which made
 * the target height a function of the current height: `target = f(current)`.
 * Every native resize re-laid out the panes, the observer measured again, and
 * the window walked to its fixed point one resize at a time — about twenty
 * native resizes (each a full WKWebView re-layout and repaint) per
 * translation, which is what made the hotkey feel slow.
 *
 * Measuring the *content* height (`scrollHeight`) and capping it against a
 * constant makes the target independent of the current height: one
 * computation, one resize. Mirrors the macOS app's `layoutWindow()`.
 */

/** Chrome around the two panes: top padding + divider gutters + footer. */
export const CHROME_HEIGHT = 105;

/** Never smaller than this, so an empty card is still a usable target. */
export const MIN_HEIGHT = 240;

/** Card width in CSS pixels. Fixed, like the macOS card. */
export const CARD_WIDTH = 400;

/** Share of the work area the source pane may occupy. */
export const SOURCE_AREA_SHARE = 0.35;

/** Share of the work area the translation pane may occupy. */
export const TRANSLATION_AREA_SHARE = 0.45;

export interface TranslateWindowSizing {
  /** Full rendered height of the source pane's text, in CSS pixels. */
  sourceContentHeight: number;
  /** Full rendered height of the translation pane's text, in CSS pixels. */
  translationContentHeight: number;
  /** Usable height of the display the card appears on, in CSS pixels. */
  workAreaHeight: number;
  /**
   * True while the translation is still arriving.
   *
   * A streaming translation arrives in chunks, and each chunk made the card
   * taller, so the window climbed one native resize at a time — the same
   * staircase the feedback loop used to produce, only slower. While the
   * translation streams in, the window is therefore sized for the room the
   * *source* needs, and corrected once when the translation has landed.
   */
  streaming: boolean;
}

/**
 * The height a pane is allowed to occupy: its content, capped to its share of
 * the work area. Past the cap the pane scrolls.
 */
export function paneHeight(
  contentHeight: number,
  workAreaHeight: number,
  share: number,
): number {
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) return 0;
  const cap = workAreaHeight * share;
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  return Math.min(contentHeight, cap);
}

/** The cap for one pane, in CSS pixels. */
export function paneCap(workAreaHeight: number, share: number): number {
  if (!Number.isFinite(workAreaHeight) || workAreaHeight <= 0) return 0;
  return workAreaHeight * share;
}

/** The height the source pane occupies: its text, capped to its share. */
export function sourcePaneHeight(
  contentHeight: number,
  workAreaHeight: number,
): number {
  return paneHeight(contentHeight, workAreaHeight, SOURCE_AREA_SHARE);
}

/**
 * The height the translation pane occupies.
 *
 * While the translation streams in, the pane is sized for the room the source
 * needed — a translation runs about as long as the text it translates — and
 * *not* for the text that has arrived so far. The streamed length is unknown
 * until the last chunk lands, so tying the height to it would make the window
 * grow one native resize per chunk: the same staircase as the feedback loop,
 * only slower. Sizing for the source instead keeps one height for the whole
 * translation.
 *
 * Once the translation has landed, the pane takes exactly the height its text
 * needs, like the macOS app's `layoutWindow()`.
 */
export function translationPaneHeight(
  contentHeight: number,
  sourceContentHeight: number,
  workAreaHeight: number,
  streaming: boolean,
): number {
  const cap = paneCap(workAreaHeight, TRANSLATION_AREA_SHARE);
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  const needed = streaming ? sourceContentHeight : contentHeight;
  if (!Number.isFinite(needed) || needed <= 0) return 0;
  return Math.min(needed, cap);
}

/**
 * The height the card should take for the given content.
 *
 * Depends only on the content and the display's work area — never on the
 * window's current height.
 */
export function translateWindowHeight(sizing: TranslateWindowSizing): number {
  const source = sourcePaneHeight(sizing.sourceContentHeight, sizing.workAreaHeight);
  const translation = translationPaneHeight(
    sizing.translationContentHeight,
    sizing.sourceContentHeight,
    sizing.workAreaHeight,
    sizing.streaming,
  );
  return Math.max(MIN_HEIGHT, Math.ceil(CHROME_HEIGHT + source + translation));
}

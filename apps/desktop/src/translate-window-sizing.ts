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

/**
 * The height the card should take for the given content.
 *
 * Depends only on the content and the display's work area — never on the
 * window's current height.
 */
export function translateWindowHeight(sizing: TranslateWindowSizing): number {
  const source = paneHeight(
    sizing.sourceContentHeight,
    sizing.workAreaHeight,
    SOURCE_AREA_SHARE,
  );
  const translation = paneHeight(
    sizing.translationContentHeight,
    sizing.workAreaHeight,
    TRANSLATION_AREA_SHARE,
  );
  return Math.max(MIN_HEIGHT, Math.ceil(CHROME_HEIGHT + source + translation));
}

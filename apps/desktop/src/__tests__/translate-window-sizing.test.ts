import { describe, expect, it } from "vitest";
import {
  CHROME_HEIGHT,
  MIN_HEIGHT,
  SOURCE_AREA_SHARE,
  TRANSLATION_AREA_SHARE,
  paneCap,
  paneHeight,
  translateWindowHeight,
} from "../translate-window-sizing";

/**
 * The translate window sizes itself to its content. These tests pin the
 * property that keeps the hotkey feeling fast: the target height must be a
 * function of the content and the display, never of the window's current
 * height.
 *
 * The previous implementation capped the panes in `vh` and measured the
 * *capped* height, which made the target height `f(current height)`. Every
 * native resize re-laid out the panes, the observer measured again, and the
 * window walked to its fixed point one resize at a time — roughly twenty
 * native resizes per translation, each a full webview re-layout and repaint.
 */

const WORK_AREA = 900;

describe("paneCap", () => {
  it("is a constant of the display, not of the window", () => {
    expect(paneCap(WORK_AREA, SOURCE_AREA_SHARE)).toBe(315);
    expect(paneCap(WORK_AREA, TRANSLATION_AREA_SHARE)).toBe(405);
  });

  it("is zero when the display geometry is unknown", () => {
    expect(paneCap(0, SOURCE_AREA_SHARE)).toBe(0);
    expect(paneCap(Number.NaN, SOURCE_AREA_SHARE)).toBe(0);
  });
});

describe("paneHeight", () => {
  it("keeps short content whole", () => {
    expect(paneHeight(120, WORK_AREA, SOURCE_AREA_SHARE)).toBe(120);
  });

  it("caps long content to the pane's share of the work area", () => {
    expect(paneHeight(5000, WORK_AREA, SOURCE_AREA_SHARE)).toBe(315);
    expect(paneHeight(5000, WORK_AREA, TRANSLATION_AREA_SHARE)).toBe(405);
  });

  it("treats missing content as empty", () => {
    expect(paneHeight(0, WORK_AREA, SOURCE_AREA_SHARE)).toBe(0);
    expect(paneHeight(-10, WORK_AREA, SOURCE_AREA_SHARE)).toBe(0);
  });
});

describe("translateWindowHeight", () => {
  it("grows with the content", () => {
    const short = translateWindowHeight({
      sourceContentHeight: 60,
      translationContentHeight: 40,
      workAreaHeight: WORK_AREA,
    });
    const long = translateWindowHeight({
      sourceContentHeight: 300,
      translationContentHeight: 260,
      workAreaHeight: WORK_AREA,
    });
    // 60 + 40 does not even cover the chrome, so the minimum height wins.
    expect(short).toBe(MIN_HEIGHT);
    expect(long).toBe(CHROME_HEIGHT + 560);
    expect(long).toBeGreaterThan(short);
  });

  it("never drops below the minimum height", () => {
    expect(
      translateWindowHeight({
        sourceContentHeight: 0,
        translationContentHeight: 0,
        workAreaHeight: WORK_AREA,
      }),
    ).toBe(MIN_HEIGHT);
  });

  it("is the same for the same content whatever the window's current height", () => {
    // The decoupling property: the function has no window height input at
    // all, so the height cannot drift with the window it is sizing.
    const sizing = {
      sourceContentHeight: 420,
      translationContentHeight: 380,
      workAreaHeight: WORK_AREA,
    };
    const heights = new Set(
      [240, 320, 400, 480, 520, 700, 900].map(() => translateWindowHeight(sizing)),
    );
    expect(heights.size).toBe(1);
  });

  it("caps a long translation at the pane's share of the work area", () => {
    expect(
      translateWindowHeight({
        sourceContentHeight: 315,
        translationContentHeight: 9000,
        workAreaHeight: WORK_AREA,
      }),
    ).toBe(CHROME_HEIGHT + 315 + 405);
  });
});

describe("the feedback loop this replaced", () => {
  /** The old rule: measure the capped height, which depends on the window. */
  const legacyHeight = (currentHeight: number, source: number, translation: number) =>
    Math.max(
      MIN_HEIGHT,
      Math.ceil(
        CHROME_HEIGHT +
          Math.min(source, 0.35 * currentHeight) +
          Math.min(translation, 0.45 * currentHeight),
      ),
    );

  it("took many native resizes to settle", () => {
    const source = 9000;
    const translation = 9000;
    let height = 240;
    const seen: number[] = [];
    for (let i = 0; i < 40; i++) {
      const next = legacyHeight(height, source, translation);
      seen.push(next);
      if (next === height) break;
      height = next;
    }
    // A long translation used to walk the window up in dozens of steps, one
    // native resize (and one full webview re-layout) each.
    expect(seen.length).toBeGreaterThan(5);
    expect(seen).toContain(525);
  });

  it("left the card's maximum height independent of the display", () => {
    // The old rule's fixed point fell out of the pane fractions and the
    // chrome height alone, so the card could never grow past 525 px however
    // much room the display had.
    let height = 240;
    for (let i = 0; i < 40; i++) {
      const next = legacyHeight(height, 9000, 9000);
      if (next === height) break;
      height = next;
    }
    expect(height).toBe(525);

    // The new rule scales with the display, like the macOS app does.
    expect(
      translateWindowHeight({
        sourceContentHeight: 9000,
        translationContentHeight: 9000,
        workAreaHeight: WORK_AREA,
      }),
    ).toBe(CHROME_HEIGHT + 315 + 405);
  });

  it("keeps the card inside the display", () => {
    for (const workAreaHeight of [600, 900, 1440]) {
      const height = translateWindowHeight({
        sourceContentHeight: 9000,
        translationContentHeight: 9000,
        workAreaHeight,
      });
      expect(height).toBeLessThanOrEqual(workAreaHeight);
    }
  });
});

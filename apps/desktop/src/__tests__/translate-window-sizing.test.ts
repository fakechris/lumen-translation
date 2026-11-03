import { describe, expect, it } from "vitest";
import {
  CHROME_HEIGHT,
  MIN_HEIGHT,
  SOURCE_AREA_SHARE,
  TRANSLATION_AREA_SHARE,
  paneCap,
  paneHeight,
  sourcePaneHeight,
  translateWindowHeight,
  translationPaneHeight,
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

describe("sourcePaneHeight", () => {
  it("keeps short content whole and caps long content", () => {
    expect(sourcePaneHeight(120, WORK_AREA)).toBe(120);
    expect(sourcePaneHeight(5000, WORK_AREA)).toBe(315);
  });
});

describe("translationPaneHeight", () => {
  it("takes the height of the text once the translation has landed", () => {
    expect(translationPaneHeight(260, 300, WORK_AREA, false)).toBe(260);
  });

  it("ignores the streamed text while the translation is arriving", () => {
    // The final length of a streaming translation is unknown, so the pane is
    // sized for the source instead: the window keeps one height for the whole
    // translation rather than growing one native resize per chunk.
    expect(translationPaneHeight(0, 300, WORK_AREA, true)).toBe(300);
    expect(translationPaneHeight(120, 300, WORK_AREA, true)).toBe(300);
    expect(translationPaneHeight(9000, 300, WORK_AREA, true)).toBe(300);
  });

  it("caps the streaming height at the pane's share of the work area", () => {
    expect(translationPaneHeight(0, 9000, WORK_AREA, true)).toBe(405);
  });
});

describe("translateWindowHeight", () => {
  it("grows with the content", () => {
    const short = translateWindowHeight({
      sourceContentHeight: 60,
      translationContentHeight: 40,
      workAreaHeight: WORK_AREA,
      streaming: false,
    });
    const long = translateWindowHeight({
      sourceContentHeight: 300,
      translationContentHeight: 260,
      workAreaHeight: WORK_AREA,
      streaming: false,
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
        streaming: false,
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
      streaming: false,
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
        streaming: false,
      }),
    ).toBe(CHROME_HEIGHT + 315 + 405);
  });
});

describe("streaming", () => {
  it("keeps one height while the translation streams in", () => {
    const heights = new Set(
      [0, 40, 120, 260, 300, 420, 900].map((partial) =>
        translateWindowHeight({
          sourceContentHeight: 300,
          translationContentHeight: partial,
          workAreaHeight: WORK_AREA,
          streaming: true,
        }),
      ),
    );
    expect(heights.size).toBe(1);
  });

  it("sizes the window for the source while the translation streams in", () => {
    expect(
      translateWindowHeight({
        sourceContentHeight: 300,
        translationContentHeight: 0,
        workAreaHeight: WORK_AREA,
        streaming: true,
      }),
    ).toBe(CHROME_HEIGHT + 300 + 300);
  });

  it("corrects the height once the translation lands", () => {
    const streaming = translateWindowHeight({
      sourceContentHeight: 300,
      translationContentHeight: 300,
      workAreaHeight: WORK_AREA,
      streaming: true,
    });
    const landed = translateWindowHeight({
      sourceContentHeight: 300,
      translationContentHeight: 260,
      workAreaHeight: WORK_AREA,
      streaming: false,
    });
    expect(landed).toBe(CHROME_HEIGHT + 300 + 260);
    expect(landed).not.toBe(streaming);
  });

  it("asks the window for at most two heights over a whole translation", () => {
    // The real sequence: the source lands, chunks arrive one by one, the
    // translation lands. Every distinct height is one native resize.
    const source = 300;
    const heights: number[] = [];
    const ask = (partial: number, streaming: boolean) => {
      const height = translateWindowHeight({
        sourceContentHeight: source,
        translationContentHeight: partial,
        workAreaHeight: WORK_AREA,
        streaming,
      });
      if (heights[heights.length - 1] !== height) heights.push(height);
    };

    ask(0, true);
    for (const partial of [10, 60, 120, 200, 260, 300, 300]) ask(partial, true);
    ask(300, false);

    expect(heights.length).toBeLessThanOrEqual(2);
  });

  it("asks for one height when the translation is as long as the source", () => {
    // A long translation is capped at the pane's share of the work area, so
    // the streaming height and the landed height coincide: nothing to correct.
    const source = 9000;
    const streaming = translateWindowHeight({
      sourceContentHeight: source,
      translationContentHeight: 0,
      workAreaHeight: WORK_AREA,
      streaming: true,
    });
    const landed = translateWindowHeight({
      sourceContentHeight: source,
      translationContentHeight: 9000,
      workAreaHeight: WORK_AREA,
      streaming: false,
    });
    expect(streaming).toBe(landed);
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
        streaming: false,
      }),
    ).toBe(CHROME_HEIGHT + 315 + 405);
  });

  it("keeps the card inside the display", () => {
    for (const workAreaHeight of [600, 900, 1440]) {
      const height = translateWindowHeight({
        sourceContentHeight: 9000,
        translationContentHeight: 9000,
        workAreaHeight,
        streaming: false,
      });
      expect(height).toBeLessThanOrEqual(workAreaHeight);
    }
  });
});

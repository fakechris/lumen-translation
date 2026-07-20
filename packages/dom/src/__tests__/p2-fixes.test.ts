// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { detectParagraphs } from "../detect.js";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("same-origin iframe traversal", () => {
  it("detects paragraphs inside a same-origin iframe document body", () => {
    document.body.innerHTML = `<p id="outer">Outer paragraph text</p><iframe id="frame"></iframe>`;
    const iframe = document.getElementById("frame") as HTMLIFrameElement;
    // jsdom exposes contentDocument for same-origin (about:blank) iframes.
    const doc = iframe.contentDocument;
    expect(doc).not.toBeNull();
    doc!.body.innerHTML = `<p id="inner">Inner iframe paragraph content</p>`;

    const texts = detectParagraphs({ root: document.body }).map((p) => p.text);
    expect(texts).toContain("Outer paragraph text");
    expect(texts).toContain("Inner iframe paragraph content");
  });

  it("does not throw when the iframe is not yet loaded (no body)", () => {
    document.body.innerHTML = `<p id="outer">Outer paragraph text</p><iframe id="empty"></iframe>`;
    const iframe = document.getElementById("empty") as HTMLIFrameElement;
    // Wipe the iframe's body so there is nothing to descend into.
    if (iframe.contentDocument) iframe.contentDocument.body.innerHTML = "";
    expect(() => detectParagraphs({ root: document.body })).not.toThrow();
    const texts = detectParagraphs({ root: document.body }).map((p) => p.text);
    expect(texts).toContain("Outer paragraph text");
  });
});

describe("rule.paragraphSelectors wiring", () => {
  it("uses paragraphSelectors as the explicit candidate set", () => {
    document.body.innerHTML = `
      <div class="card">Card one content</div>
      <div class="card">Card two content</div>
      <p>Ignored paragraph</p>`;

    const paras = detectParagraphs({
      root: document.body,
      rule: { match: "*", paragraphSelectors: [".card"] },
    });
    const texts = paras.map((p) => p.text);

    expect(texts).toContain("Card one content");
    expect(texts).toContain("Card two content");
    // The <p> does not match .card, so it is not collected.
    expect(texts).not.toContain("Ignored paragraph");
  });

  it("falls back to default tag heuristic when paragraphSelectors is absent", () => {
    document.body.innerHTML = `<div class="card">Card content</div><p>A paragraph</p>`;
    const texts = detectParagraphs({ root: document.body }).map((p) => p.text);
    expect(texts).toContain("A paragraph");
  });
});

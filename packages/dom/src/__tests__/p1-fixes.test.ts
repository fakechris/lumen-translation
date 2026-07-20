// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  detectParagraphs,
  inlineToText,
  renderTranslatedFragment,
  serializeInline,
  deepDescendants,
} from "../detect.js";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("hidden-element filtering", () => {
  it("excludes display:none, visibility:hidden, [hidden] and aria-hidden paragraphs", () => {
    document.body.innerHTML = `
      <p id="vis">Visible paragraph text</p>
      <p id="dn" style="display:none">Display none text</p>
      <p id="vh" style="visibility:hidden">Visibility hidden text</p>
      <p id="hid" hidden>Hidden attribute text</p>
      <p id="ah" aria-hidden="true">Aria hidden text</p>`;

    const ids = detectParagraphs({ root: document.body }).map((p) => p.node.id);

    expect(ids).toContain("vis");
    expect(ids).not.toContain("dn");
    expect(ids).not.toContain("vh");
    expect(ids).not.toContain("hid");
    expect(ids).not.toContain("ah");
  });
});

describe("open shadow root traversal", () => {
  it("detects paragraphs inside an open shadow root", () => {
    document.body.innerHTML = `<div id="host"></div><p id="light">Light text here</p>`;
    const host = document.getElementById("host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<p id="shadow-p">Shadow paragraph content</p>`;

    const paras = detectParagraphs({ root: document.body });
    const texts = paras.map((p) => p.text);

    expect(texts).toContain("Shadow paragraph content");
    expect(texts).toContain("Light text here");
  });

  it("does not descend into closed shadow roots", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const host = document.getElementById("host")!;
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<p>Closed shadow text</p>`;

    const texts = detectParagraphs({ root: document.body }).map((p) => p.text);
    expect(texts).not.toContain("Closed shadow text");
  });

  it("deepDescendants yields open-shadow elements", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const host = document.getElementById("host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<span class="inner">x</span>`;

    const tags = Array.from(deepDescendants(document.body)).map((el) =>
      el.className || el.tagName.toLowerCase(),
    );
    expect(tags).toContain("inner");
  });
});

describe("inline <code> text preservation", () => {
  it("keeps inline code text in the segment and round-trips it", () => {
    document.body.innerHTML = "<p>Run <code>npm run build</code> now</p>";
    const el = document.querySelector("p")!;
    const inline = serializeInline(el);

    expect(inlineToText(inline)).toMatch(/Run <0>npm run build<\/0> now/);

    const frag = renderTranslatedFragment("运行 <0>npm run build</0> 现在", inline);
    const host = document.createElement("div");
    host.appendChild(frag);

    expect(host.querySelector("code")).not.toBeNull();
    expect(host.querySelector("code")?.textContent).toBe("npm run build");
    expect(host.textContent).toBe("运行 npm run build 现在");
  });

  it("collects a paragraph whose only rich content is inline code", () => {
    document.body.innerHTML = "<p id=c>Use <code>x</code></p>";
    const texts = detectParagraphs({ root: document.body }).map((p) => p.text);
    expect(texts.some((t) => t.includes("x"))).toBe(true);
  });
});

describe("attribute-replay XSS is neutralized", () => {
  it("drops on* handlers and javascript: URIs during snapshot", () => {
    document.body.innerHTML =
      `<p>Go <a href="javascript:alert(1)" onclick="steal()" title="safe">here</a></p>`;
    const el = document.querySelector("p")!;
    const inline = serializeInline(el);
    const anchor = inline.find((n) => n.type === "tag" && n.tag === "a");

    expect(anchor?.attrs?.onclick).toBeUndefined();
    expect(anchor?.attrs?.href).toBeUndefined();
    expect(anchor?.attrs?.title).toBe("safe");
  });

  it("does not replay onload/onerror or javascript: URIs on rebuild", () => {
    document.body.innerHTML =
      `<p>Img <img src="javascript:alert(2)" onload="hack()" onerror="hack()" alt="pic"></p>`;
    const el = document.querySelector("p")!;
    const inline = serializeInline(el);

    const frag = renderTranslatedFragment(inlineToText(inline), inline);
    const host = document.createElement("div");
    host.appendChild(frag);
    const img = host.querySelector("img")!;

    expect(img.hasAttribute("onload")).toBe(false);
    expect(img.hasAttribute("onerror")).toBe(false);
    expect(img.hasAttribute("src")).toBe(false);
    expect(img.getAttribute("alt")).toBe("pic");
  });

  it("preserves safe attributes and safe URLs", () => {
    document.body.innerHTML = `<p>See <a href="/docs" title="t" onclick="x()">docs</a></p>`;
    const el = document.querySelector("p")!;
    const inline = serializeInline(el);
    const frag = renderTranslatedFragment(inlineToText(inline), inline);
    const host = document.createElement("div");
    host.appendChild(frag);
    const a = host.querySelector("a")!;

    expect(a.getAttribute("href")).toBe("/docs");
    expect(a.getAttribute("title")).toBe("t");
    expect(a.hasAttribute("onclick")).toBe(false);
  });
});

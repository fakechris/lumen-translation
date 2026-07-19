// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { serializeInline, inlineToText, renderTranslatedFragment } from "./detect.js";

describe("serializeInline / renderTranslatedFragment", () => {
  it("round-trips plain text", () => {
    document.body.innerHTML = "<p>Hello world</p>";
    const el = document.querySelector("p")!;
    const inline = serializeInline(el);
    expect(inlineToText(inline)).toBe("Hello world");
    const frag = renderTranslatedFragment("你好世界", inline);
    const host = document.createElement("div");
    host.appendChild(frag);
    expect(host.textContent).toBe("你好世界");
  });

  it("preserves inline <a> structure with markers", () => {
    document.body.innerHTML = "<p>See <a href=\"/x\">docs</a> here</p>";
    const el = document.querySelector("p")!;
    const inline = serializeInline(el);
    // The serialized text contains markers like <0>...</0>
    expect(inlineToText(inline)).toMatch(/See <0>docs<\/0> here/);
    // Rebuild using the translated text that keeps the marker.
    const frag = renderTranslatedFragment("见 <0>文档</0> 这里", inline);
    const host = document.createElement("div");
    host.appendChild(frag);
    const anchor = host.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href")).toBe("/x");
    expect(anchor?.textContent).toBe("文档");
    expect(host.textContent).toBe("见 文档 这里");
  });
});

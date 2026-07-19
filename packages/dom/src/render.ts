import { renderTranslatedFragment } from "./detect.js";
import type { TranslatedParagraph } from "./types.js";

/** Insert translated paragraphs under their originals as a bilingual layout. */
export function renderBilingual(results: TranslatedParagraph[]): void {
  for (const r of results) {
    const original = r.original;
    if (!original || !original.isConnected) continue;
    const originalEl = original as HTMLElement;
    // Remove any previous translation we attached.
    const prev = originalEl.nextElementSibling;
    if (prev && prev.tagName === "LUMEN-TRANSLATION") prev.remove();

    const wrapper = document.createElement("lumen-translation");
    wrapper.setAttribute("data-lumen-for", r.id);
    wrapper.setAttribute("data-lumen-style", r.style ?? "blue");
    wrapper.className = "lumen-translation";
    wrapper.dir = r.dir ?? "auto";
    const frag = renderTranslatedFragment(r.text, r.inline);
    wrapper.appendChild(frag);
    originalEl.insertAdjacentElement("afterend", wrapper);
    if (r.hideOriginal) originalEl.style.display = "none";
  }
}

/** Remove all lumen-translation elements and restore originals. */
export function clearBilingual(root: Document | Element = document): void {
  const nodes = root.querySelectorAll("lumen-translation");
  nodes.forEach((n) => {
    const prev = n.previousElementSibling as HTMLElement | null;
    if (prev && prev.hasAttribute("data-lumen-id")) {
      prev.style.display = "";
    }
    n.remove();
  });
}

import type { Rule, Segment } from "@lumen/core";

/** Tags whose entire subtree we never translate. */
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "SVG",
  "CANVAS",
  "VIDEO",
  "AUDIO",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "BUTTON",
  "CODE",
  "KBD",
  "SAMP",
  "VAR",
  "PRE",
  "TEMPLATE",
  "LUMEN-TRANSLATION",
]);

/** Block-ish tags that we treat as paragraph roots. */
const PARAGRAPH_TAGS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "BLOCKQUOTE",
  "DD",
  "DT",
  "TD",
  "TH",
  "CAPTION",
  "FIGCAPTION",
  "SUMMARY",
  "ARTICLE",
  "SECTION",
  "ASIDE",
  "DIV",
  "SPAN",
]);

const INLINE_TAGS = new Set([
  "A",
  "B",
  "STRONG",
  "I",
  "EM",
  "U",
  "S",
  "SMALL",
  "SUB",
  "SUP",
  "MARK",
  "ABBR",
  "CITE",
  "Q",
  "BR",
  "SPAN",
  "TIME",
  "LABEL",
]);

export interface DetectionOptions {
  root?: Element | Document;
  rule?: Rule;
  /** Minimum visible text length to bother translating. */
  minTextLength?: number;
}

export interface DetectedParagraph {
  /** Stable id (data-lumen-id). */
  id: string;
  node: Element;
  /** Plain text with inline placeholders for rich content. */
  text: string;
  /** The serialized inline structure used to reconstruct rich text. */
  inline: InlineNode[];
}

export interface InlineNode {
  type: "text" | "tag";
  /** For text nodes, the literal text. For tags, the placeholder marker. */
  value: string;
  /** For tag nodes, the tag name lowercase. */
  tag?: string;
  /** For tag nodes, attributes that we preserve on rebuild. */
  attrs?: Record<string, string>;
}

let idCounter = 0;
const nextId = () => `l${(++idCounter).toString(36)}`;

/**
 * Walk the DOM under `root` and collect paragraph-level blocks worth
 * translating. Skips elements matched by `rule.excludeSelectors`.
 */
export function detectParagraphs(opts: DetectionOptions = {}): DetectedParagraph[] {
  const root = opts.root ?? document;
  const minLen = opts.minTextLength ?? 1;
  const rule = opts.rule;

  const excludeMatcher = rule?.excludeSelectors?.length
    ? compileSelectorMatcher(rule.excludeSelectors)
    : null;
  const rootSelector = rule?.rootSelector;
  const roots: Element[] = rootSelector
    ? Array.from((root as Document | Element).querySelectorAll?.(rootSelector) ?? [])
    : [root as Element];

  if (roots.length === 0) roots.push(root as Element);

  const out: DetectedParagraph[] = [];
  const seen = new WeakSet<Element>();

  for (const r of roots) {
    walk(r, (el) => {
      if (seen.has(el)) return "skip";
      if (SKIP_TAGS.has(el.tagName)) return "skip";
      if (excludeMatcher?.(el)) return "skip";
      // Skip elements we already translated into.
      if (el.tagName === "LUMEN-TRANSLATION") return "skip";
      // If this element has a block child that is itself a paragraph root,
      // recurse rather than taking the whole subtree.
      const directBlock = hasBlockChild(el);
      const ownText = ownOrLeafText(el);
      if (!directBlock && ownText && ownText.trim().length >= minLen) {
        seen.add(el);
        const id = el.getAttribute("data-lumen-id") ?? nextId();
        el.setAttribute("data-lumen-id", id);
        const inline = serializeInline(el);
        out.push({ id, node: el, text: inlineToText(inline), inline });
        return "skip"; // don't double-collect descendants
      }
      return "recurse";
    });
  }
  return out;
}

export function paragraphsToSegments(paragraphs: DetectedParagraph[]): Segment[] {
  return paragraphs.map((p, i) => ({
    id: p.id,
    text: p.text,
    context: {
      prev: i > 0 ? paragraphs[i - 1].text.slice(0, 200) : undefined,
      next: i < paragraphs.length - 1 ? paragraphs[i + 1].text.slice(0, 200) : undefined,
    },
    meta: { paragraphId: p.id },
  }));
}

function walk(
  root: Element,
  visit: (el: Element) => "skip" | "recurse" | void,
): void {
  // Depth-first traversal using element children.
  const stack: Element[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    const action = visit(el);
    if (action === "skip") continue;
    // Push children in reverse so we visit in document order.
    const children = el.children;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }
}

function hasBlockChild(el: Element): boolean {
  for (const child of el.children) {
    if (PARAGRAPH_TAGS.has(child.tagName) && !INLINE_TAGS.has(child.tagName)) {
      // Treat DIV/SPAN as block only if they themselves contain block content.
      if ((child.tagName === "DIV" || child.tagName === "SPAN") && !hasBlockChild(child)) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function ownOrLeafText(el: Element): string {
  // Concatenate text from this element's subtree (used to decide whether the
  // element carries meaningful text). For leaf-ish elements this is just text.
  return (el.textContent ?? "").trim();
}

/** Serialize an element's content into a flat list of inline nodes. */
export function serializeInline(el: Element): InlineNode[] {
  const out: InlineNode[] = [];
  let markerIndex = 0;
  const walkNode = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (text.length > 0) out.push({ type: "text", value: text });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (SKIP_TAGS.has(child.tagName)) return;
    if (child.tagName === "BR") {
      out.push({ type: "text", value: "\n" });
      return;
    }
    const marker = `<${markerIndex++}>`;
    out.push({
      type: "tag",
      value: marker,
      tag: child.tagName.toLowerCase(),
      attrs: snapshotAttrs(child),
    });
    for (const c of child.childNodes) walkNode(c);
    out.push({ type: "tag", value: `</${markerIndex - 1}>` });
  };
  for (const c of el.childNodes) walkNode(c);
  return out;
}

function snapshotAttrs(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of el.attributes) {
    // Skip class/style/data-lumen-* to keep the placeholder stable.
    if (attr.name === "class" || attr.name === "style" || attr.name.startsWith("data-lumen-")) {
      continue;
    }
    attrs[attr.name] = attr.value;
  }
  return attrs;
}

export function inlineToText(inline: InlineNode[]): string {
  return inline.map((n) => n.value).join("");
}

/**
 * Render a translated text (which contains the same `<n>` markers as the
 * source) back into a DOM fragment mirroring the original inline structure.
 */
export function renderTranslatedFragment(
  translatedText: string,
  template: InlineNode[],
  doc: Document = document,
): DocumentFragment {
  const frag = doc.createDocumentFragment();
  // Build a lookup of marker index -> inline tag node.
  const openByIndex = new Map<number, InlineNode>();
  for (const n of template) {
    if (n.type === "tag") {
      const m = n.value.match(/^<(\d+)>$/);
      if (m) openByIndex.set(Number(m[1]), n);
    }
  }
  // Tokenize translatedText into text + markers.
  const tokens = translatedText.split(/(<\/?\d+>)/).filter(Boolean);
  const stack: { el: Element; markerIndex: number }[] = [];
  for (const tok of tokens) {
    const open = tok.match(/^<(\d+)>$/);
    const close = tok.match(/^<\/(\d+)>$/);
    if (open) {
      const idx = Number(open[1]);
      const node = openByIndex.get(idx);
      const tag = node?.tag ?? "span";
      const el = doc.createElement(tag);
      if (node?.attrs) {
        for (const [k, v] of Object.entries(node.attrs)) el.setAttribute(k, v);
      }
      if (stack.length) stack[stack.length - 1].el.appendChild(el);
      else frag.appendChild(el);
      stack.push({ el, markerIndex: idx });
    } else if (close) {
      const idx = Number(close[1]);
      // Pop until we find the matching open marker.
      while (stack.length && stack[stack.length - 1].markerIndex !== idx) {
        stack.pop();
      }
      if (stack.length) stack.pop();
    } else if (tok.length > 0) {
      const textNode = doc.createTextNode(tok);
      if (stack.length) stack[stack.length - 1].el.appendChild(textNode);
      else frag.appendChild(textNode);
    }
  }
  // Fallback: if no markers were used, the whole string is plain text.
  if (frag.childNodes.length === 0 && translatedText.length > 0) {
    frag.appendChild(doc.createTextNode(translatedText));
  }
  return frag;
}

function compileSelectorMatcher(selectors: string[]): (el: Element) => boolean {
  try {
    const lists = selectors.map((s) => s.trim()).filter(Boolean);
    return (el) => lists.some((s) => el.matches(s));
  } catch {
    return () => false;
  }
}

/** Skip tags exported for reuse by tests / userscript. */
export { SKIP_TAGS, PARAGRAPH_TAGS, INLINE_TAGS };

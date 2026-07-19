import type { InlineNode } from "./detect.js";
import type { TranslationStyle } from "@lumen/core";

export interface TranslatedParagraph {
  id: string;
  /** The translated text with the same `<n>` markers as the original. */
  text: string;
  /** The original element the translation is attached to. */
  original: Element | null;
  /** The inline template captured at detection time. */
  inline: InlineNode[];
  /** Whether to hide the original (translation-only mode). */
  hideOriginal?: boolean;
  /** Text direction for the wrapper. */
  dir?: "ltr" | "rtl" | "auto";
  /** Visual style of the bilingual block. */
  style?: TranslationStyle;
}

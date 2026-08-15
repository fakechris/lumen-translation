/**
 * Language codes and labels.
 *
 * The list and its bilingual labels mirror `apps/popclip/Config.json` so the
 * Windows app offers exactly the same languages as the macOS PopClip action;
 * `langLabel` mirrors `TranslationService.langLabel` in `LLMService.swift`
 * (the English name is what goes into the LLM system prompt).
 */

export interface LangOption {
  code: string;
  label: string;
}

export const TARGET_LANGS: LangOption[] = [
  { code: "zh-CN", label: "中文（简体）" },
  { code: "zh-TW", label: "中文（繁體）" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "ru", label: "Русский" },
  { code: "ar", label: "العربية" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "th", label: "ไทย" },
  { code: "vi", label: "Tiếng Việt" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "hi", label: "हिन्दी" },
  { code: "tr", label: "Türkçe" },
  { code: "nl", label: "Nederlands" },
  { code: "pl", label: "Polski" },
];

export const SOURCE_LANGS: LangOption[] = [
  { code: "auto", label: "自动检测 Auto Detect" },
  ...TARGET_LANGS,
];

const LABELS: Record<string, string> = {
  "zh-cn": "Simplified Chinese",
  "zh-hans": "Simplified Chinese",
  zh: "Simplified Chinese",
  "zh-tw": "Traditional Chinese",
  "zh-hant": "Traditional Chinese",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  fr: "French",
  de: "German",
  es: "Spanish",
  ru: "Russian",
  ar: "Arabic",
  it: "Italian",
  pt: "Portuguese",
  th: "Thai",
  vi: "Vietnamese",
  id: "Indonesian",
  hi: "Hindi",
  tr: "Turkish",
  nl: "Dutch",
  pl: "Polish",
};

/** English name of a language code, for LLM prompts. Unknown codes pass through. */
export function langLabel(code: string): string {
  return LABELS[code.toLowerCase()] ?? code;
}

/**
 * Region auto-detection, ported from `Region.autoDetect()` in
 * `Preferences.swift`. Chinese locales and the two mainland time zones get the
 * domestic endpoints; everything else uses the overseas ones.
 */
export function autoDetectRegion(
  // Defaulted defensively rather than read straight off `navigator`: this runs
  // under vitest's node environment too, where neither global is guaranteed.
  locale: string = globalThis.navigator?.language ?? "en-US",
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
): "cn" | "overseas" {
  const l = locale.toLowerCase().replace("_", "-");
  if (
    l.startsWith("zh-cn") ||
    l.startsWith("zh-hans") ||
    l.startsWith("zh-hant") ||
    timeZone === "Asia/Shanghai" ||
    timeZone === "Asia/Urumqi"
  ) {
    return "cn";
  }
  return "overseas";
}

/**
 * @lumen/core — core translation abstractions.
 *
 * Everything in this package is engine-agnostic and DOM-agnostic so it can be
 * reused by the browser extension, the userscript, a future mobile shell, or
 * any third-party embedder.
 */

export type LangCode = string;

export interface LanguagePair {
  source: LangCode;
  target: LangCode;
}

/** A single chunk of source text scheduled for translation. */
export interface Segment {
  /** Stable id within a translation request (used for caching & dedupe). */
  id: string;
  /** Plain text to translate. May contain inline markers for rich text. */
  text: string;
  /** Optional surrounding context for AI engines (previous segment, etc). */
  context?: {
    prev?: string;
    next?: string;
  };
  /** Opaque metadata attached by the caller (e.g. DOM node ref). */
  meta?: unknown;
}

export interface TranslatedSegment {
  id: string;
  /** Translated text, matching the inline-marker shape of the input. */
  text: string;
  /** Whether the engine reported this as a cached / no-op result. */
  cached?: boolean;
}

export interface EngineRequest {
  pair: LanguagePair;
  segments: Segment[];
  /** Terminology hints for AI engines. */
  glossary?: GlossaryEntry[];
  /** Arbitrary per-request options consumed by the engine. */
  options?: Record<string, unknown>;
}

export interface EngineResult {
  segments: TranslatedSegment[];
  /** Bytes consumed / tokens, for telemetry (never sent anywhere). */
  usage?: { tokens?: number; chars?: number };
}

export interface GlossaryEntry {
  source: string;
  target: string;
  /** Optional domain hint (e.g. "medical", "legal"). */
  domain?: string;
}

/**
 * A translation engine. Implementations may call a remote API, a local model,
 * or the browser's built-in Translator API.
 */
export interface Engine {
  /** Stable identifier, e.g. "google", "openai", "builtin". */
  readonly id: string;
  /** Human-readable label. */
  readonly label: string;
  /** Whether this engine supports streaming AI responses. */
  readonly supportsStreaming?: boolean;
  /** Whether this engine benefits from batching multiple segments. */
  readonly supportsBatch?: boolean;
  /** Translate a batch of segments. */
  translate(req: EngineRequest): Promise<EngineResult>;
  /** Optional streaming variant; emits one TranslatedSegment at a time. */
  translateStream?: (req: EngineRequest) => AsyncIterable<TranslatedSegment>;
  /** Probe the engine to verify credentials. Returns error message or null. */
  test?(): Promise<string | null>;
}

/** Per-site or per-domain translation rule. */
export interface Rule {
  /** Match expression: URL pattern (glob) or regex string. */
  match: string;
  /** CSS selector for the root container to translate within. */
  rootSelector?: string;
  /** CSS selectors of elements to skip. */
  excludeSelectors?: string[];
  /** Extra CSS selectors of elements to treat as paragraph boundaries. */
  paragraphSelectors?: string[];
  /** Override the default target language for this site. */
  targetLang?: LangCode;
  /** Extra glossary entries applied on top of the global glossary. */
  glossary?: GlossaryEntry[];
  /** Whether to keep the original text visible (default true). */
  bilingual?: boolean;
  /** Arbitrary engine-specific overrides. */
  engineOptions?: Record<string, unknown>;
}

/** Visual style of the bilingual translation block. */
export type TranslationStyle = "blue" | "green" | "plain" | "minimal";

/**
 * Common configuration shape for a translation engine. Providers may store
 * extra provider-specific fields via the index signature.
 */
export interface EngineConfig {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  region?: "domestic" | "overseas";
  [key: string]: unknown;
}

/** User settings stored by the host (extension/userscript). */
export interface Settings {
  activeEngineId: string;
  targetLang: LangCode;
  sourceLang: LangCode | "auto";
  bilingual: boolean;
  style: TranslationStyle;
  glossary: GlossaryEntry[];
  rules: Rule[];
  subscribedRuleUrls: string[];
  shortcuts: Record<string, string>;
  concurrency: number;
  maxBatchSize: number;
  /**
   * Engine-specific configuration plus internal cross-cutting keys such as
   * `__sync__`. Kept as `Record<string, unknown>` so the sync config path does
   * not need to conform to `EngineConfig`.
   */
  engines: Record<string, unknown>;
}

export const DEFAULT_SETTINGS: Settings = {
  activeEngineId: "google",
  targetLang: "zh",
  sourceLang: "auto",
  bilingual: true,
  style: "blue",
  glossary: [],
  rules: [],
  subscribedRuleUrls: [],
  // NOTE: these are cross-platform default accelerator strings ("Modifier+Key"
  // form), not browser-specific bindings. They are intentionally kept in core
  // because both the extension and the userscript read them as the baseline
  // default and override per-platform at the binding layer. The host (browser
  // extension / userscript / mobile shell) is responsible for translating the
  // string into a platform key event; core never interprets these. Moving
  // them out of core would force every consumer (including packages/sync's
  // merge tests) to duplicate the baseline, so the lower-risk choice is to
  // keep them here as a shared cross-platform default.
  shortcuts: {
    toggleTranslate: "Alt+Q",
    toggleStyle: "Alt+C",
    openPopup: "Alt+K",
    translateSelection: "Alt+S",
    openOptions: "Alt+O",
    translateInput: "Alt+I",
  },
  concurrency: 6,
  maxBatchSize: 32,
  engines: {},
};

export class TranslationError extends Error {
  constructor(
    message: string,
    public readonly engineId: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TranslationError";
  }
}

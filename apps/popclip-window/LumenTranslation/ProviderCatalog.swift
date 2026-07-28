// Provider catalog: data-driven provider presets decoded from the vendored
// Lumen product-suite provider catalog contract (`lumen.provider-catalog/v1`).
//
// Single source of truth: packages/engines/src/provider-catalog.v1.json —
// a byte-for-byte copy of lumen-suite `contracts/provider-catalog.v1.json`,
// refreshed with `node scripts/sync-provider-catalog.mjs`. build.sh copies it
// into the app bundle's Resources, and this file decodes it at launch.
// Provider data (endpoints, models, headers, quirks) must never be hardcoded
// here again; only UI policy (the curated short-list below) lives in code.

import Foundation

// MARK: - JSON value (for free-form catalog fields like quirks body_params)

/// Minimal JSON value so `quirks.no_thinking.body_params` (arbitrary JSON)
/// can be decoded while keeping `ProviderPreset` Hashable.
enum JSONValue: Decodable, Hashable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case null
  case array([JSONValue])
  case object([String: JSONValue])

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() {
      self = .null
    } else if let b = try? c.decode(Bool.self) {
      self = .bool(b)
    } else if let n = try? c.decode(Double.self) {
      self = .number(n)
    } else if let s = try? c.decode(String.self) {
      self = .string(s)
    } else if let a = try? c.decode([JSONValue].self) {
      self = .array(a)
    } else if let o = try? c.decode([String: JSONValue].self) {
      self = .object(o)
    } else {
      throw DecodingError.dataCorruptedError(
        in: c, debugDescription: "unsupported JSON value")
    }
  }

  /// Bridge back to Foundation types for JSONSerialization request bodies.
  var anyValue: Any {
    switch self {
    case .string(let s): return s
    case .number(let n):
      // Preserve integer-ness where possible (e.g. thinking_budget: 0).
      if n == n.rounded(), n.magnitude < 1e15 { return Int(n) }
      return n
    case .bool(let b): return b
    case .null: return NSNull()
    case .array(let a): return a.map { $0.anyValue }
    case .object(let o): return o.mapValues { $0.anyValue }
    }
  }
}

// MARK: - Catalog Codable models (subset of provider-catalog.schema.json
// that this app consumes)

struct CatalogFile: Decodable {
  let spec: String
  let version: String
  let providers: [CatalogProvider]
}

struct CatalogDisplayName: Decodable {
  let en: String
  let zh: String?
}

struct CatalogEndpoint: Decodable {
  let baseURL: String

  enum CodingKeys: String, CodingKey {
    case baseURL = "base_url"
  }
}

struct CatalogEndpoints: Decodable {
  let cn: CatalogEndpoint?
  let global: CatalogEndpoint?
  let local: CatalogEndpoint?
}

struct CatalogNoThinking: Decodable {
  let strategy: String
  let bodyParams: [String: JSONValue]
  /// Case-insensitive substrings; inject only when the model name matches.
  let modelFilter: [String]?

  enum CodingKeys: String, CodingKey {
    case strategy
    case bodyParams = "body_params"
    case modelFilter = "model_filter"
  }
}

struct CatalogQuirks: Decodable {
  let noThinking: CatalogNoThinking?

  enum CodingKeys: String, CodingKey {
    case noThinking = "no_thinking"
  }
}

struct CatalogProvider: Decodable {
  let id: String
  let aliases: [String]?
  let displayName: CatalogDisplayName
  let apiStyle: String
  let region: String
  let capabilities: [String]
  let endpoints: CatalogEndpoints?
  let chatPath: String?
  let defaultModel: String?
  let models: [String]?
  let needsKey: Bool
  let extraHeaders: [String: String]?
  let docsURL: String?
  let quirks: CatalogQuirks?

  enum CodingKeys: String, CodingKey {
    case id, aliases, region, capabilities, endpoints, models, quirks
    case displayName = "display_name"
    case apiStyle = "api_style"
    case chatPath = "chat_path"
    case defaultModel = "default_model"
    case needsKey = "needs_key"
    case extraHeaders = "extra_headers"
    case docsURL = "docs_url"
  }
}

// MARK: - Loader

enum CatalogLoadError: Error, CustomStringConvertible {
  case badSpec(String)

  var description: String {
    switch self {
    case .badSpec(let s):
      return "unexpected catalog spec \"\(s)\" (want lumen.provider-catalog/v1)"
    }
  }
}

enum CatalogLoader {
  static let expectedSpec = "lumen.provider-catalog/v1"
  static let resourceName = "provider-catalog.v1"

  static func load(from url: URL) throws -> CatalogFile {
    let data = try Data(contentsOf: url)
    let file = try JSONDecoder().decode(CatalogFile.self, from: data)
    guard file.spec == expectedSpec else {
      throw CatalogLoadError.badSpec(file.spec)
    }
    return file
  }

  /// Load the catalog copied into the app bundle by build.sh. Returns nil
  /// (never crashes) if the resource is missing or corrupt.
  static func loadBundled() -> CatalogFile? {
    guard let url = Bundle.main.url(forResource: resourceName, withExtension: "json") else {
      NSLog("[LumenTranslation] provider catalog resource missing from bundle")
      return nil
    }
    do {
      return try load(from: url)
    } catch {
      NSLog("[LumenTranslation] failed to load provider catalog: \(error)")
      return nil
    }
  }
}

// MARK: - App-facing preset (adapter view over a catalog entry)

struct ProviderPreset: Identifiable, Hashable {
  let id: String
  let label: String
  /// Catalog wire protocol (`openai_compat`, `google_translate`, ...).
  let apiStyle: String
  /// Primary endpoint (cn if the provider has one, else global/local).
  let endpointCN: String
  /// Overseas endpoint when the provider has separate cn + global endpoints.
  let endpointOverseas: String?
  let defaultModel: String
  let models: [String]
  let docsURL: String?
  /// Whether this provider needs an API key.
  let needsKey: Bool
  /// Static headers sent with every request (e.g. OpenRouter attribution).
  let extraHeaders: [String: String]
  /// Historical ids used by older builds / sibling Lumen apps.
  let aliases: [String]
  /// From catalog `quirks.no_thinking`: body params that disable
  /// chain-of-thought output on reasoning models.
  let noThinkingBodyParams: [String: JSONValue]?
  let noThinkingModelFilter: [String]?

  /// Body params to merge into a chat request to disable "thinking" output,
  /// honoring the catalog's case-insensitive `model_filter` substrings.
  /// nil when nothing should be injected for this model.
  func noThinkingInjection(for model: String) -> [String: Any]? {
    guard let params = noThinkingBodyParams else { return nil }
    if let filter = noThinkingModelFilter {
      let m = model.lowercased()
      guard filter.contains(where: { m.contains($0.lowercased()) }) else { return nil }
    }
    return params.mapValues { $0.anyValue }
  }
}

enum Providers {
  /// Curated short-list (Option 2B), same UI policy as before: the two free
  /// MT engines + OpenAI + OpenRouter + four major Chinese providers.
  /// Only the *set and order* of ids is app policy; all provider data comes
  /// from the catalog.
  ///
  /// Note: the old hand-rolled "Anthropic (Claude, via OpenRouter)" preset is
  /// replaced by the canonical `openrouter` entry — this app only speaks the
  /// OpenAI-compatible protocol, so the catalog's native `anthropic` entry
  /// (Messages API) is not usable here; OpenRouter still offers the Claude
  /// models (see `legacyIdMap` for settings migration).
  static let curatedIds = [
    "google_translate",
    "microsoft_translator",
    "openai",
    "openrouter",
    "kimi",
    "glm",
    "minimax",
    "deepseek",
  ]

  /// App-local legacy ids -> canonical catalog ids, beyond the catalog's own
  /// `aliases`. "anthropic" was this app's OpenRouter-routed Claude preset;
  /// its saved key was always an OpenRouter key.
  static let legacyIdMap = ["anthropic": "openrouter"]

  static let catalog: [ProviderPreset] = makeCatalog(CatalogLoader.loadBundled())

  /// Filtered adapter view of the catalog file: the curated ids, in order,
  /// that this app can actually drive.
  static func makeCatalog(_ file: CatalogFile?) -> [ProviderPreset] {
    guard let file = file else { return fallbackCatalog }
    let byId = Dictionary(uniqueKeysWithValues: file.providers.map { ($0.id, $0) })
    let presets = curatedIds.compactMap { id -> ProviderPreset? in
      guard let p = byId[id], isSupported(p) else { return nil }
      return toPreset(p)
    }
    return presets.isEmpty ? fallbackCatalog : presets
  }

  /// Wire protocols this app implements: OpenAI-compatible chat completions
  /// (mirrors `isBuiltinChatProvider` in packages/engines/src/providers.ts,
  /// minus its app-specific exclusion of `openai`) plus the two free MT
  /// engines that have dedicated code paths in LLMService.
  private static func isSupported(_ p: CatalogProvider) -> Bool {
    if p.capabilities.contains("chat") {
      return p.apiStyle == "openai_compat" && p.region != "local"
    }
    return p.capabilities.contains("translation")
      && (p.apiStyle == "google_translate" || p.apiStyle == "microsoft_translator")
  }

  private static func toPreset(_ p: CatalogProvider) -> ProviderPreset? {
    guard let endpoints = p.endpoints,
          let primary = endpoints.cn ?? endpoints.global ?? endpoints.local else {
      return nil
    }
    // openai_compat base_url does not include the chat path; MT-style
    // base_url is already the full endpoint.
    let chatPath = p.apiStyle == "openai_compat" ? (p.chatPath ?? "/chat/completions") : ""
    let overseas: String?
    if endpoints.cn != nil, let global = endpoints.global {
      overseas = global.baseURL + chatPath
    } else {
      overseas = nil
    }
    let noThinking = p.quirks?.noThinking?.strategy == "body_params"
      ? p.quirks?.noThinking : nil
    return ProviderPreset(
      id: p.id,
      label: label(for: p.displayName),
      apiStyle: p.apiStyle,
      endpointCN: primary.baseURL + chatPath,
      endpointOverseas: overseas,
      defaultModel: p.defaultModel ?? "",
      models: p.models ?? [],
      docsURL: p.docsURL,
      needsKey: p.needsKey,
      extraHeaders: p.extraHeaders ?? [:],
      aliases: p.aliases ?? [],
      noThinkingBodyParams: noThinking?.bodyParams,
      noThinkingModelFilter: noThinking?.modelFilter)
  }

  /// Compose a UI label from the bilingual display name (same heuristic as
  /// packages/engines/src/providers.ts `toLabel`): if the Chinese name
  /// already contains the vendor's Latin name ("MiniMax 大模型"), use it
  /// alone; otherwise prefix the English name ("DeepSeek 深度求索").
  private static func label(for name: CatalogDisplayName) -> String {
    guard let zh = name.zh, zh != name.en else { return name.en }
    let enFirstWord = name.en
      .split(whereSeparator: { $0 == " " || $0 == "(" || $0 == "（" })
      .first.map { $0.lowercased() } ?? ""
    if !enFirstWord.isEmpty, zh.lowercased().contains(enFirstWord) {
      return zh
    }
    return "\(name.en) \(zh)"
  }

  static func find(_ id: String) -> ProviderPreset? {
    find(id, in: catalog)
  }

  /// Resolve an id against a specific preset list (injectable for tests):
  /// canonical id first, then catalog aliases ("google", "minimax-cn", ...),
  /// then app-local legacy ids ("anthropic").
  static func find(_ id: String, in catalog: [ProviderPreset]) -> ProviderPreset? {
    if let preset = catalog.first(where: { $0.id == id }) { return preset }
    if let preset = catalog.first(where: { $0.aliases.contains(id) }) { return preset }
    if let mapped = legacyIdMap[id] {
      return catalog.first { $0.id == mapped }
    }
    return nil
  }

  /// Last-resort presets if the bundled catalog is missing or corrupt (a
  /// build error — build.sh always embeds it). Keeps the free, keyless
  /// engines working instead of crashing.
  private static let fallbackCatalog: [ProviderPreset] = [
    ProviderPreset(
      id: "google_translate",
      label: "Google 翻译（免费，无需 Key）",
      apiStyle: "google_translate",
      endpointCN: "https://translate.googleapis.com/translate_a/single",
      endpointOverseas: nil,
      defaultModel: "gtx",
      models: ["gtx"],
      docsURL: "https://translate.google.com",
      needsKey: false,
      extraHeaders: [:],
      aliases: ["google"],
      noThinkingBodyParams: nil,
      noThinkingModelFilter: nil),
    ProviderPreset(
      id: "microsoft_translator",
      label: "微软翻译（免费，无需 Key）",
      apiStyle: "microsoft_translator",
      endpointCN: "https://api.cognitive.microsofttranslator.com/translate",
      endpointOverseas: nil,
      defaultModel: "free",
      models: ["free"],
      docsURL: "https://www.bing.com/translator",
      needsKey: false,
      extraHeaders: [:],
      aliases: ["microsoft"],
      noThinkingBodyParams: nil,
      noThinkingModelFilter: nil),
  ]
}

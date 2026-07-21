// LumenWindow preferences: persisted provider selection, API keys, models,
// and region. Stored in UserDefaults so they survive across launches and are
// readable from the TranslateCommand handler.
//
// Region auto-detection (Option 3A): if the user has not explicitly chosen a
// region, we infer it from the system locale and time zone.
//   - locale is zh-CN / zh-Hans / zh-Hant *or* timezone starts with "Asia/Shanghai"
//     or "Asia/Urumqi" -> "cn"
//   - otherwise -> "overseas"

import Foundation

struct ProviderPreset: Identifiable, Hashable {
  let id: String
  let label: String
  /// Domestic (mainland China) endpoint.
  let endpointCN: String
  /// Overseas endpoint; falls back to endpointCN if absent.
  let endpointOverseas: String?
  let defaultModel: String
  let models: [String]
  let docsURL: String
  /// Whether this provider needs an API key.
  let needsKey: Bool
  /// Optional extra headers.
  let extraHeaders: [String: String]
}

enum Providers {
  /// Curated short-list (Option 2B): OpenAI / Anthropic-via-OpenRouter +
  /// four major Chinese providers (Kimi, GLM, MiniMax, DeepSeek).
  static let catalog: [ProviderPreset] = [
    ProviderPreset(
      id: "google",
      label: "Google（免费，无需 Key）",
      endpointCN: "https://translate.googleapis.com/translate_a/single",
      endpointOverseas: nil,
      defaultModel: "gtx",
      models: ["gtx"],
      docsURL: "https://translate.google.com",
      needsKey: false,
      extraHeaders: [:]),
    ProviderPreset(
      id: "microsoft",
      label: "Microsoft（免费，无需 Key）",
      endpointCN: "https://api.cognitive.microsofttranslator.com/translate",
      endpointOverseas: nil,
      defaultModel: "free",
      models: ["free"],
      docsURL: "https://www.bing.com/translator",
      needsKey: false,
      extraHeaders: [:]),
    ProviderPreset(
      id: "openai",
      label: "OpenAI (GPT)",
      endpointCN: "https://api.openai.com/v1/chat/completions",
      endpointOverseas: nil,
      defaultModel: "gpt-4o-mini",
      models: ["gpt-4o-mini", "gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"],
      docsURL: "https://platform.openai.com/api-keys",
      needsKey: true,
      extraHeaders: [:]),
    ProviderPreset(
      id: "anthropic",
      label: "Anthropic (Claude, via OpenRouter)",
      // Anthropic's native API uses a different request schema than
      // OpenAI-compatible chat completions. To keep a single code path we
      // route through OpenRouter, which exposes Claude via the OpenAI schema.
      endpointCN: "https://openrouter.ai/api/v1/chat/completions",
      endpointOverseas: nil,
      defaultModel: "anthropic/claude-3.5-sonnet",
      models: [
        "anthropic/claude-3.5-sonnet",
        "anthropic/claude-3.5-haiku",
        "anthropic/claude-3-opus",
      ],
      docsURL: "https://openrouter.ai/keys",
      needsKey: true,
      extraHeaders: [
        "HTTP-Referer": "https://github.com/fakechris/lumen-translation",
        "X-Title": "Lumen Translation",
      ]),
    ProviderPreset(
      id: "kimi",
      label: "Kimi 月之暗面 Moonshot",
      endpointCN: "https://api.moonshot.cn/v1/chat/completions",
      endpointOverseas: nil,
      defaultModel: "moonshot-v1-8k",
      models: ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k", "kimi-latest"],
      docsURL: "https://platform.moonshot.cn/console/api-keys",
      needsKey: true,
      extraHeaders: [:]),
    ProviderPreset(
      id: "glm",
      label: "GLM 智谱 BigModel",
      endpointCN: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      endpointOverseas: nil,
      defaultModel: "glm-4-flash",
      models: ["glm-4-plus", "glm-4-air", "glm-4-flash", "glm-4-long", "glm-4"],
      docsURL: "https://open.bigmodel.cn/usercenter/apikeys",
      needsKey: true,
      extraHeaders: [:]),
    ProviderPreset(
      id: "minimax",
      label: "MiniMax 大模型",
      endpointCN: "https://api.minimaxi.com/v1/text/chatcompletion_v2",
      endpointOverseas: "https://api.minimax.chat/v1/text/chatcompletion_v2",
      defaultModel: "MiniMax-Text-01",
      models: ["MiniMax-Text-01", "abab6.5s-chat", "abab6.5-chat", "abab6-chat"],
      docsURL: "https://platform.minimaxi.com/user-center/basic-information/interface-key",
      needsKey: true,
      extraHeaders: [:]),
    ProviderPreset(
      id: "deepseek",
      label: "DeepSeek 深度求索",
      endpointCN: "https://api.deepseek.com/v1/chat/completions",
      endpointOverseas: nil,
      defaultModel: "deepseek-chat",
      models: ["deepseek-chat", "deepseek-reasoner", "deepseek-coder"],
      docsURL: "https://platform.deepseek.com/api-keys",
      needsKey: true,
      extraHeaders: [:]),
  ]

  static func find(_ id: String) -> ProviderPreset? {
    catalog.first { $0.id == id }
  }
}

/// Region detection (Option 3A): auto unless user has explicitly chosen.
enum Region {
  static func autoDetect() -> String {
    let locale = Locale.current.identifier.lowercased()
    let tz = TimeZone.current.identifier
    if locale.hasPrefix("zh_cn") || locale.hasPrefix("zh-cn")
      || locale.hasPrefix("zh_hans") || locale.hasPrefix("zh-hans")
      || locale.hasPrefix("zh_hant") || locale.hasPrefix("zh-hant")
      || tz == "Asia/Shanghai" || tz == "Asia/Urumqi" {
      return "cn"
    }
    return "overseas"
  }
}

/// Read/write preferences to UserDefaults. Keys are namespaced under
/// `lumen.popclip-window.*`.
final class Preferences {
  static let shared = Preferences()
  private let defaults = UserDefaults.standard

  private enum Key {
    static let provider = "lumen.provider"
    static let apiKey = "lumen.apiKey." // + providerId
    static let model = "lumen.model."   // + providerId
    static let region = "lumen.region"  // "cn" | "overseas"
    static let targetLang = "lumen.targetLang"
    static let sourceLang = "lumen.sourceLang"
  }

  var providerId: String {
    get { defaults.string(forKey: Key.provider) ?? "google" }
    set { defaults.set(newValue, forKey: Key.provider) }
  }

  var provider: ProviderPreset {
    Providers.find(providerId) ?? Providers.catalog[0]
  }

  /// Region override. nil means "auto".
  var regionOverride: String? {
    get { defaults.string(forKey: Key.region) }
    set {
      if let v = newValue {
        defaults.set(v, forKey: Key.region)
      } else {
        defaults.removeObject(forKey: Key.region)
      }
    }
  }

  /// Effective region: explicit override or auto-detected.
  var effectiveRegion: String {
    regionOverride ?? Region.autoDetect()
  }

  func apiKey(for providerId: String) -> String {
    defaults.string(forKey: Key.apiKey + providerId) ?? ""
  }
  func setApiKey(_ key: String, for providerId: String) {
    defaults.set(key, forKey: Key.apiKey + providerId)
  }

  func model(for providerId: String) -> String {
    if let saved = defaults.string(forKey: Key.model + providerId) {
      return saved
    }
    return Providers.find(providerId)?.defaultModel ?? ""
  }
  func setModel(_ model: String, for providerId: String) {
    defaults.set(model, forKey: Key.model + providerId)
  }

  var targetLang: String {
    get { defaults.string(forKey: Key.targetLang) ?? "zh-CN" }
    set { defaults.set(newValue, forKey: Key.targetLang) }
  }

  var sourceLang: String {
    get { defaults.string(forKey: Key.sourceLang) ?? "auto" }
    set { defaults.set(newValue, forKey: Key.sourceLang) }
  }

  /// Resolve the endpoint for a provider given the effective region.
  func endpoint(for preset: ProviderPreset) -> String {
    if effectiveRegion == "overseas", let overseas = preset.endpointOverseas {
      return overseas
    }
    return preset.endpointCN
  }
}

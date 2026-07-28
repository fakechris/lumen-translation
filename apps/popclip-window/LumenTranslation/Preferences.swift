// LumenWindow preferences: persisted provider selection, API keys, models,
// and region. Stored in UserDefaults so they survive across launches and are
// readable from the TranslateCommand handler.
//
// Provider presets come from the vendored lumen-suite provider catalog (see
// ProviderCatalog.swift); this file only handles persistence, legacy-id
// migration, and region resolution.
//
// Region auto-detection (Option 3A): if the user has not explicitly chosen a
// region, we infer it from the system locale and time zone.
//   - locale is zh-CN / zh-Hans / zh-Hant *or* timezone starts with "Asia/Shanghai"
//     or "Asia/Urumqi" -> "cn"
//   - otherwise -> "overseas"

import Foundation

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

  private init() {
    migrateLegacyProviderData()
  }

  /// Older builds stored app-local provider ids ("google", "microsoft",
  /// "anthropic" = Claude via OpenRouter). Resolve them to canonical catalog
  /// ids (via catalog aliases + Providers.legacyIdMap) and carry saved API
  /// keys / models over to the canonical namespace. Unknown saved ids fall
  /// back to the default provider instead of crashing.
  private func migrateLegacyProviderData() {
    // Per-provider apiKey/model namespaces.
    for preset in Providers.catalog {
      var legacyIds = preset.aliases
      legacyIds += Providers.legacyIdMap.filter { $0.value == preset.id }.map { $0.key }
      for old in legacyIds where old != preset.id {
        if defaults.string(forKey: Key.apiKey + preset.id) == nil,
           let key = defaults.string(forKey: Key.apiKey + old) {
          defaults.set(key, forKey: Key.apiKey + preset.id)
        }
        if defaults.string(forKey: Key.model + preset.id) == nil,
           let model = defaults.string(forKey: Key.model + old) {
          defaults.set(model, forKey: Key.model + preset.id)
        }
      }
    }
    // Selected provider id.
    if let saved = defaults.string(forKey: Key.provider) {
      if let preset = Providers.find(saved) {
        if preset.id != saved {
          defaults.set(preset.id, forKey: Key.provider)
        }
      } else {
        // Unknown id (e.g. a provider no longer in the curated list):
        // fall back to the default.
        defaults.removeObject(forKey: Key.provider)
      }
    }
  }

  /// Canonical catalog id for any saved/incoming id (handles legacy ids from
  /// PopClip `configure` calls, e.g. "google" or "anthropic").
  private func canonicalId(_ id: String) -> String {
    Providers.find(id)?.id ?? id
  }

  var providerId: String {
    get { defaults.string(forKey: Key.provider) ?? "google_translate" }
    set { defaults.set(canonicalId(newValue), forKey: Key.provider) }
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
    defaults.string(forKey: Key.apiKey + canonicalId(providerId)) ?? ""
  }
  func setApiKey(_ key: String, for providerId: String) {
    defaults.set(key, forKey: Key.apiKey + canonicalId(providerId))
  }

  func model(for providerId: String) -> String {
    let id = canonicalId(providerId)
    if let saved = defaults.string(forKey: Key.model + id) {
      return saved
    }
    return Providers.find(id)?.defaultModel ?? ""
  }
  func setModel(_ model: String, for providerId: String) {
    defaults.set(model, forKey: Key.model + canonicalId(providerId))
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

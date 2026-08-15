// Shared language catalog for the translate window's quick language switcher
// and the Preferences → General tab. Codes match the PopClip extension
// options (apps/popclip/Config.json) and the engine language codes.

import Foundation

struct LanguageOption {
  let code: String
  let label: String
}

enum LanguageCatalog {
  static let auto = "auto"

  static let all: [LanguageOption] = [
    .init(code: "zh-CN", label: "中文（简体）"),
    .init(code: "zh-TW", label: "中文（繁體）"),
    .init(code: "en", label: "English"),
    .init(code: "ja", label: "日本語"),
    .init(code: "ko", label: "한국어"),
    .init(code: "fr", label: "Français"),
    .init(code: "de", label: "Deutsch"),
    .init(code: "es", label: "Español"),
    .init(code: "ru", label: "Русский"),
    .init(code: "ar", label: "العربية"),
    .init(code: "it", label: "Italiano"),
    .init(code: "pt", label: "Português"),
    .init(code: "th", label: "ไทย"),
    .init(code: "vi", label: "Tiếng Việt"),
    .init(code: "id", label: "Bahasa Indonesia"),
    .init(code: "hi", label: "हिन्दी"),
    .init(code: "tr", label: "Türkçe"),
    .init(code: "nl", label: "Nederlands"),
    .init(code: "pl", label: "Polski"),
  ]

  /// Source picker list: auto-detect first, then explicit languages.
  static let sourceOptions: [LanguageOption] =
    [LanguageOption(code: auto, label: "自动检测 Auto Detect")] + all

  /// Target picker list: a translation always needs an explicit target, so
  /// there is no "auto" entry (mirrors Bob's target-language selector).
  static let targetOptions: [LanguageOption] = all

  static func label(for code: String) -> String {
    if code.isEmpty || code == auto { return "自动检测 Auto Detect" }
    return all.first { $0.code == code }?.label ?? code
  }
}

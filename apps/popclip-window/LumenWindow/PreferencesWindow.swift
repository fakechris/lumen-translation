// Preferences window for LumenWindow.
//
// Opened from the status bar item (LSUIElement apps have no app menu, so
// Preferences is reachable via NSStatusItem + a tiny SwiftUI window).
//
// Layout: provider dropdown, model dropdown, API key field, region selector,
// source/target language selectors, link to docs.

import AppKit
import SwiftUI

enum PreferencesWindowController {
  static func show() {
    NSApp.activate(ignoringOtherApps: true)
    let controller = NSWindowController(
      window: NSPanel(
        contentRect: NSRect(x: 0, y: 0, width: 480, height: 520),
        styleMask: [.titled, .closable, .fullSizeContentView],
        backing: .buffered,
        defer: false))
    controller.window?.title = "Lumen Preferences"
    controller.window?.isReleasedWhenClosed = false
    controller.window?.center()
    controller.window?.contentView = NSHostingView(rootView: PreferencesView())
    controller.showWindow(nil)
    controller.window?.makeKeyAndOrderFront(nil)
  }
}

struct PreferencesView: View {
  @State private var providerId: String = Preferences.shared.providerId
  @State private var apiKey: String = ""
  @State private var model: String = ""
  @State private var regionOverride: String = ""
  @State private var targetLang: String = Preferences.shared.targetLang
  @State private var sourceLang: String = Preferences.shared.sourceLang

  var currentPreset: ProviderPreset {
    Providers.find(providerId) ?? Providers.catalog[0]
  }

  var body: some View {
    Form {
      Section("Translation Engine") {
        Picker("Provider", selection: $providerId) {
          ForEach(Providers.catalog) { p in
            Text(p.label).tag(p.id)
          }
        }
        .onChange(of: providerId) { newId in
          Preferences.shared.providerId = newId
          if let p = Providers.find(newId) {
            apiKey = Preferences.shared.apiKey(for: newId)
            model = Preferences.shared.model(for: newId)
            _ = p
          }
        }
        .onAppear {
          apiKey = Preferences.shared.apiKey(for: providerId)
          model = Preferences.shared.model(for: providerId)
          regionOverride = Preferences.shared.regionOverride ?? "auto"
        }

        if currentPreset.models.count > 1 {
          Picker("Model", selection: $model) {
            ForEach(currentPreset.models, id: \.self) { m in
              Text(m).tag(m)
            }
          }
          .onChange(of: model) { v in
            Preferences.shared.setModel(v, for: providerId)
          }
        }

        if currentPreset.needsKey {
          SecureField("API Key", text: $apiKey)
            .onChange(of: apiKey) { v in
              Preferences.shared.setApiKey(v, for: providerId)
            }
          HStack(spacing: 4) {
            Image(systemName: "questionmark.circle")
              .foregroundStyle(.secondary)
            Link("Get API key", destination: URL(string: currentPreset.docsURL)!)
              .font(.caption)
          }
        } else {
          Text("No API key required.")
            .foregroundStyle(.secondary)
            .font(.caption)
        }
      }

      Section("Region") {
        Picker("Endpoint region", selection: $regionOverride) {
          Text("Auto (system locale / timezone)").tag("auto")
          Text("China (国内)").tag("cn")
          Text("Overseas (海外)").tag("overseas")
        }
        .onChange(of: regionOverride) { v in
          Preferences.shared.regionOverride = v == "auto" ? nil : v
        }
        if currentPreset.endpointOverseas == nil {
          Text("This provider has a single global endpoint; region has no effect.")
            .foregroundStyle(.tertiary)
            .font(.caption)
        }
      }

      Section("Languages") {
        Picker("Source", selection: $sourceLang) {
          Text("Auto Detect").tag("auto")
          ForEach(languageOptions, id: \.code) { l in
            Text(l.label).tag(l.code)
          }
        }
        .onChange(of: sourceLang) { v in Preferences.shared.sourceLang = v }

        Picker("Target", selection: $targetLang) {
          ForEach(languageOptions, id: \.code) { l in
            Text(l.label).tag(l.code)
          }
        }
        .onChange(of: targetLang) { v in Preferences.shared.targetLang = v }
      }
    }
    .formStyle(.grouped)
    .frame(width: 460, height: 500)
    .padding()
  }
}

private struct LanguageOption {
  let code: String
  let label: String
}

private let languageOptions: [LanguageOption] = [
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

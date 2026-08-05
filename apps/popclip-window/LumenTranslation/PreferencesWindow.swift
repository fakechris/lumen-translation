// Preferences window for LumenTranslation.
//
// Tabbed settings:
//   - AI Provider: provider dropdown, model, API key (show/hide), validate
//   - General: region, source/target language
//   - About: version, links
//
// Opened from the status bar item (LSUIElement apps have no app menu).

import AppKit
import SwiftUI

enum PreferencesWindowController {
  static func show() {
    NSApp.activate(ignoringOtherApps: true)
    let controller = NSWindowController(
      window: NSPanel(
        contentRect: NSRect(x: 0, y: 0, width: 520, height: 560),
        styleMask: [.titled, .closable, .fullSizeContentView],
        backing: .buffered,
        defer: false))
    controller.window?.title = "Lumen Translation Settings"
    controller.window?.isReleasedWhenClosed = false
    controller.window?.center()
    controller.window?.contentView = NSHostingView(rootView: PreferencesView())
    controller.showWindow(nil)
    controller.window?.makeKeyAndOrderFront(nil)
  }
}

struct PreferencesView: View {
  @State private var selectedTab = 0

  var body: some View {
    VStack(spacing: 0) {
      TabView(selection: $selectedTab) {
        ProviderTab()
          .tabItem {
            Label("AI Provider", systemImage: "cpu")
          }
          .tag(0)

        CustomEndpointsTab()
          .tabItem {
            Label("Custom", systemImage: "square.stack.3d.up")
          }
          .tag(1)

        GeneralTab()
          .tabItem {
            Label("General", systemImage: "gearshape")
          }
          .tag(2)

        AboutTab()
          .tabItem {
            Label("About", systemImage: "info.circle")
          }
          .tag(3)
      }
      .padding(20)
    }
    .frame(width: 500, height: 540)
  }
}

// MARK: - Provider tab

struct ProviderTab: View {
  @State private var providerId: String = Preferences.shared.providerId
  @State private var apiKey: String = ""
  @State private var model: String = ""
  @State private var showKey: Bool = false
  @State private var validateState: ValidateState = .idle
  @State private var validateMessage: String = ""

  enum ValidateState {
    case idle, validating, connected, failed
  }

  var currentPreset: ProviderPreset {
    Preferences.shared.allProviders.first(where: { $0.id == providerId }) ?? Providers.catalog[0]
  }

  var body: some View {
    Form {
      Section {
        Picker("Provider", selection: $providerId) {
          ForEach(Preferences.shared.allProviders) { p in
            Text(p.label).tag(p.id)
          }
        }
        .onChange(of: providerId) { _ in
          Preferences.shared.providerId = providerId
          apiKey = Preferences.shared.apiKey(for: providerId)
          model = Preferences.shared.model(for: providerId)
          validateState = .idle
          validateMessage = ""
        }
      }

      if currentPreset.models.count > 1 {
        Section("Model") {
          Picker("Model", selection: $model) {
            ForEach(currentPreset.models, id: \.self) { m in
              Text(m).tag(m)
            }
          }
          .onChange(of: model) { _ in
            Preferences.shared.setModel(model, for: providerId)
            validateState = .idle
          }
        }
      }

      if currentPreset.needsKey {
        Section("API Key") {
          HStack {
            if showKey {
              TextField("API Key", text: $apiKey)
            } else {
              SecureField("API Key", text: $apiKey)
            }
            Button {
              showKey.toggle()
            } label: {
              Image(systemName: showKey ? "eye.slash" : "eye")
                .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .help(showKey ? "Hide key" : "Show key")
          }
          .onChange(of: apiKey) { _ in
            Preferences.shared.setApiKey(apiKey, for: providerId)
            validateState = .idle
          }

          HStack {
            Button {
              validate()
            } label: {
              switch validateState {
              case .idle:
                Label("Validate", systemImage: "checkmark.circle")
              case .validating:
                Label("Validating…", systemImage: "arrow.triangle.2.circlepath")
              case .connected:
                Label("Connected", systemImage: "checkmark.circle.fill")
                  .foregroundStyle(.green)
              case .failed:
                Label("Retry", systemImage: "exclamationmark.triangle")
                  .foregroundStyle(.orange)
              }
            }
            .disabled(validateState == .validating || apiKey.isEmpty)

            if !validateMessage.isEmpty {
              Text(validateMessage)
                .font(.caption)
                .foregroundStyle(validateState == .connected ? .green : .red)
                .lineLimit(2)
            }
          }

          if let docs = currentPreset.docsURL, let docsURL = URL(string: docs) {
            Link(destination: docsURL) {
              Label("Get API key", systemImage: "arrow.up.right.square")
                .font(.caption)
            }
          }
        }
      } else {
        Section {
          Label("No API key required.", systemImage: "checkmark.circle.fill")
            .foregroundStyle(.green)
            .font(.caption)
        }
      }
    }
    .formStyle(.grouped)
    .onAppear {
      apiKey = Preferences.shared.apiKey(for: providerId)
      model = Preferences.shared.model(for: providerId)
    }
  }

  private func validate() {
    validateState = .validating
    validateMessage = ""
    let key = apiKey
    let preset = currentPreset
    let endpoint = Preferences.shared.endpoint(for: preset)
    let mdl = Preferences.shared.model(for: providerId)

    DispatchQueue.global(qos: .userInitiated).async {
      let (success, msg) = validateProvider(
        endpoint: endpoint, apiKey: key, model: mdl, preset: preset)
      DispatchQueue.main.async {
        if success {
          validateState = .connected
          validateMessage = "Connected to \(preset.label)."
        } else {
          validateState = .failed
          validateMessage = msg
        }
      }
    }
  }
}

// MARK: - Custom endpoints tab

struct CustomEndpointsTab: View {
  @State private var customs: [CustomProvider] = Preferences.shared.customProviders
  // id -> API key, mirrored into the shared per-id key storage on edit.
  @State private var keys: [String: String] = [:]

  var body: some View {
    Form {
      Section {
        Text("Add OpenAI-compatible endpoints. Each slot keeps its own base URL, model, and API key, and shows up in the provider list and the menu-bar Engine switcher.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      ForEach($customs) { $c in
        Section(c.name.isEmpty ? "Untitled" : c.name) {
          TextField("Name", text: $c.name)
            .onChange(of: c.name) { _ in persist() }
          TextField("Base URL (e.g. https://api.example.com/v1)", text: $c.baseURL)
            .onChange(of: c.baseURL) { _ in persist() }
            .textFieldStyle(.roundedBorder)
          TextField("Model", text: $c.model)
            .onChange(of: c.model) { _ in persist() }

          SecureField("API Key", text: Binding(
            get: { keys[c.id] ?? "" },
            set: { newValue in
              keys[c.id] = newValue
              Preferences.shared.setApiKey(newValue, for: c.id)
            }))

          Button(role: .destructive) {
            remove(c)
          } label: {
            Label("Delete slot", systemImage: "trash")
          }
        }
      }

      Section {
        Button {
          add()
        } label: {
          Label("Add custom endpoint", systemImage: "plus.circle")
        }
      }
    }
    .formStyle(.grouped)
    .onAppear(perform: reload)
  }

  private func reload() {
    customs = Preferences.shared.customProviders
    var loaded: [String: String] = [:]
    for c in customs { loaded[c.id] = Preferences.shared.apiKey(for: c.id) }
    keys = loaded
  }

  private func persist() {
    Preferences.shared.customProviders = customs
  }

  private func add() {
    let slot = CustomProvider.make()
    customs.append(slot)
    keys[slot.id] = ""
    Preferences.shared.customProviders = customs
  }

  private func remove(_ c: CustomProvider) {
    customs.removeAll { $0.id == c.id }
    keys[c.id] = nil
    Preferences.shared.removeCustomProvider(id: c.id)
  }
}

// MARK: - General tab

struct GeneralTab: View {
  @State private var regionOverride: String = Preferences.shared.regionOverride ?? "auto"
  @State private var targetLang: String = Preferences.shared.targetLang
  @State private var sourceLang: String = Preferences.shared.sourceLang

  var currentPreset: ProviderPreset {
    let id = Preferences.shared.providerId
    return Preferences.shared.allProviders.first(where: { $0.id == id }) ?? Providers.catalog[0]
  }

  var body: some View {
    Form {
      Section("Endpoint Region") {
        Picker("Region", selection: $regionOverride) {
          Label("Auto (system locale / timezone)", systemImage: "globe").tag("auto")
          Label("China (国内)", systemImage: "location.fill").tag("cn")
          Label("Overseas (海外)", systemImage: "airplane").tag("overseas")
        }
        .onChange(of: regionOverride) { _ in
          Preferences.shared.regionOverride = regionOverride == "auto" ? nil : regionOverride
        }

        if currentPreset.endpointOverseas == nil {
          Label("This provider has a single global endpoint; region has no effect.",
                systemImage: "info.circle")
            .font(.caption)
            .foregroundStyle(.tertiary)
        } else {
          Label("Detected: \(Region.autoDetect() == "cn" ? "China" : "Overseas")",
                systemImage: "checkmark.circle")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
      }

      Section("Languages") {
        Picker("Source", selection: $sourceLang) {
          Text("Auto Detect").tag("auto")
          ForEach(languageOptions, id: \.code) { l in
            Text(l.label).tag(l.code)
          }
        }
        .onChange(of: sourceLang) { _ in Preferences.shared.sourceLang = sourceLang }

        Picker("Target", selection: $targetLang) {
          ForEach(languageOptions, id: \.code) { l in
            Text(l.label).tag(l.code)
          }
        }
        .onChange(of: targetLang) { _ in Preferences.shared.targetLang = targetLang }
      }
    }
    .formStyle(.grouped)
  }
}

// MARK: - About tab

struct AboutTab: View {
  private let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
  private let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"

  var body: some View {
    VStack(spacing: 16) {
      Image(nsImage: NSApp.applicationIconImage)
        .resizable()
        .interpolation(.high)
        .frame(width: 72, height: 72)

      Text("Lumen Translation")
        .font(.title2.bold())

      Text("Version \(version) (\(build))")
        .font(.caption)
        .foregroundStyle(.secondary)

      Text("Open-source bilingual translation")
        .font(.caption)
        .foregroundStyle(.secondary)

      Divider()
        .frame(width: 200)

      VStack(spacing: 8) {
        Link(destination: URL(string: "https://github.com/fakechris/lumen-translation")!) {
          Label("GitHub", systemImage: "arrow.up.right.square")
        }
        Link(destination: URL(string: "https://github.com/fakechris/lumen-translation/issues")!) {
          Label("Report an issue", systemImage: "exclamationmark.bubble")
        }
      }

      Spacer()
    }
    .padding(.top, 20)
  }
}

// MARK: - Validation logic

private func validateProvider(
  endpoint: String, apiKey: String, model: String, preset: ProviderPreset
) -> (Bool, String) {
  guard !apiKey.isEmpty else {
    return (false, "API key is empty.")
  }
  guard let url = URL(string: endpoint) else {
    return (false, "Invalid endpoint URL.")
  }

  let system = "You are a translation engine. Reply with: ok"
  var req = URLRequest(url: url)
  req.httpMethod = "POST"
  req.setValue("application/json", forHTTPHeaderField: "Content-Type")
  req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
  for (k, v) in preset.extraHeaders {
    req.setValue(v, forHTTPHeaderField: k)
  }
  req.timeoutInterval = 15

  let body: [String: Any] = [
    "model": model,
    "temperature": 0,
    "messages": [
      ["role": "system", "content": system],
      ["role": "user", "content": "test"],
    ],
  ]
  req.httpBody = try? JSONSerialization.data(withJSONObject: body)

  let sem = DispatchSemaphore(value: 0)
  var result: (Bool, String)?

  URLSession.shared.dataTask(with: req) { data, response, err in
    if let err = err {
      result = (false, err.localizedDescription)
      sem.signal()
      return
    }
    guard let http = response as? HTTPURLResponse else {
      result = (false, "No HTTP response.")
      sem.signal()
      return
    }
    if !(200...299).contains(http.statusCode) {
      let bodyStr = String(data: data ?? Data(), encoding: .utf8) ?? ""
      result = (false, "HTTP \(http.statusCode): \(bodyStr.prefix(200))")
      sem.signal()
      return
    }
    result = (true, "")
    sem.signal()
  }.resume()

  _ = sem.wait(timeout: .now() + 15)
  return result ?? (false, "Validation timed out.")
}

// MARK: - Color extension

extension ShapeStyle where Self == Color {
  static var terracotta: Color {
    Color(red: 0x9f/255, green: 0x4f/255, blue: 0x24/255)
  }
}

// MARK: - Language options

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

// Smoke test for the provider catalog loader (run via ../test-catalog.sh).
//
// Compiles ProviderCatalog.swift as a plain CLI (no app bundle) and verifies
// that the vendored provider-catalog.v1.json decodes and maps to the presets
// the app expects: curated short-list, corrected MiniMax endpoints/models,
// alias + legacy-id resolution, and no_thinking quirk injection.

import Foundation

var checks = 0
func check(_ cond: Bool, _ msg: String) {
  checks += 1
  if !cond {
    FileHandle.standardError.write("FAIL: \(msg)\n".data(using: .utf8)!)
    exit(1)
  }
}

let args = CommandLine.arguments
guard args.count == 2 else {
  FileHandle.standardError.write("usage: catalog-smoke <provider-catalog.v1.json>\n".data(using: .utf8)!)
  exit(2)
}

let file: CatalogFile
do {
  file = try CatalogLoader.load(from: URL(fileURLWithPath: args[1]))
} catch {
  FileHandle.standardError.write("FAIL: catalog did not decode: \(error)\n".data(using: .utf8)!)
  exit(1)
}

check(file.spec == "lumen.provider-catalog/v1", "spec is \(file.spec)")
check(!file.providers.isEmpty, "catalog has providers")

let presets = Providers.makeCatalog(file)

// Curated short-list, in order.
check(
  presets.map { $0.id } == [
    "google_translate", "microsoft_translator", "openai", "openrouter",
    "kimi", "glm", "minimax", "deepseek",
  ],
  "curated presets are \(presets.map { $0.id })")

// Free MT engines: full endpoint in base_url, no key.
let google = Providers.find("google_translate", in: presets)!
check(google.apiStyle == "google_translate", "google api style")
check(google.endpointCN == "https://translate.googleapis.com/translate_a/single",
      "google endpoint is \(google.endpointCN)")
check(!google.needsKey, "google needs no key")

// MiniMax: modern chat-completions endpoints + current default model
// (replaces the stale text/chatcompletion_v2 + api.minimax.chat hardcode).
let minimax = Providers.find("minimax", in: presets)!
check(minimax.endpointCN == "https://api.minimaxi.com/v1/chat/completions",
      "minimax cn endpoint is \(minimax.endpointCN)")
check(minimax.endpointOverseas == "https://api.minimax.io/v1/chat/completions",
      "minimax overseas endpoint is \(minimax.endpointOverseas ?? "nil")")
check(minimax.defaultModel == "MiniMax-M3", "minimax default model is \(minimax.defaultModel)")
check(minimax.models.contains("MiniMax-Text-01"), "legacy minimax model still selectable")

// OpenRouter: attribution headers and Claude models present.
let openrouter = Providers.find("openrouter", in: presets)!
check(openrouter.extraHeaders["HTTP-Referer"] != nil, "openrouter HTTP-Referer header")
check(openrouter.extraHeaders["X-Title"] != nil, "openrouter X-Title header")
check(openrouter.models.contains("anthropic/claude-3.5-sonnet"),
      "openrouter keeps legacy claude model selectable")
check(openrouter.needsKey, "openrouter needs a key")
check(openrouter.docsURL == "https://openrouter.ai/keys", "openrouter docs url")

// Alias + legacy-id resolution (old saved preferences keep working).
check(Providers.find("google", in: presets)?.id == "google_translate", "alias google")
check(Providers.find("microsoft", in: presets)?.id == "microsoft_translator", "alias microsoft")
check(Providers.find("anthropic", in: presets)?.id == "openrouter",
      "legacy anthropic (Claude-via-OpenRouter) resolves to openrouter")
check(Providers.find("zhipu", in: presets)?.id == "glm", "sibling-app alias zhipu")
check(Providers.find("minimax-cn", in: presets)?.id == "minimax", "sibling-app alias minimax-cn")
check(Providers.find("does-not-exist", in: presets) == nil, "unknown id resolves to nil")

// no_thinking quirk injection (data-driven, honors model_filter).
let deepseek = Providers.find("deepseek", in: presets)!
check(deepseek.noThinkingInjection(for: "deepseek-chat") == nil,
      "deepseek-chat gets no thinking injection (model_filter)")
check(deepseek.noThinkingInjection(for: "deepseek-reasoner") != nil,
      "deepseek-reasoner gets thinking injection")
let mmBody = minimax.noThinkingInjection(for: "MiniMax-M3")
check(mmBody?["thinking"] != nil, "minimax injection includes thinking param")
check(JSONSerialization.isValidJSONObject(mmBody ?? [:]),
      "injected body params serialize as JSON")

print("OK: \(checks) checks passed (catalog v\(file.version), \(file.providers.count) providers)")

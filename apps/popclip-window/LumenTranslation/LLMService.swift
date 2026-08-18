// Translation service: routes to either Google's free endpoint or an
// OpenAI-compatible chat-completions provider based on user preferences.
//
// Fallback chain: the user's selected provider is tried first; on any failure
// (e.g. Google's HTTP 429 CAPTCHA rate-limit) it falls back to the free MT
// engines (Microsoft, then Google) and finally to any configured LLM that has
// an API key set. The first provider that succeeds wins, and its label is
// reported back so the window shows which engine produced the result.
//
// Long selections (a 17 KB markdown file, say) are split into chunks of at
// most CHUNK_MAX_CHARS characters on paragraph boundaries, translated in
// order per provider, and joined back with blank lines so paragraph structure
// survives. LLM providers receive the previous chunk's translation as
// read-only context, so names and terminology stay consistent across chunk
// boundaries. Without this, a full-length translation takes tens of seconds
// for one request and blows the per-request timeout.
//
// PopClip action -> TranslateCommand -> TranslationService.translate(...).

import Foundation

enum TranslationError: Error, CustomStringConvertible {
  case badRequest(String)
  case http(Int, String)
  case parse(String)

  var description: String {
    switch self {
    case .badRequest(let m): return "badRequest: \(m)"
    case .http(let code, let body):
      // Error bodies can be large (e.g. Google's HTML CAPTCHA page on 429);
      // keep the message readable.
      let snippet = body.replacingOccurrences(of: "\n", with: " ")
        .trimmingCharacters(in: .whitespaces)
      return "HTTP \(code): \(snippet.prefix(200))"
    case .parse(let m): return "parse error: \(m)"
    }
  }
}

enum TranslationOutcome {
  /// `detectedLang` is the source language the engine auto-detected when the
  /// requested source was "auto" (nil for explicit sources and for LLM
  /// providers, which don't report detection). The translate window uses it
  /// to make the language-swap button reverse the direction intelligently.
  case success(String, engine: String, detectedLang: String?)
  case failure(String)
}

final class TranslationService {
  static let shared = TranslationService()

  private let session: URLSession
  // NOTE: The translation system prompt and temperature are intentionally NOT
  // part of the provider catalog v1 (call-parameter defaults are product
  // policy, not vendor facts — see lumen-suite contracts/PROVIDER_CATALOG.md
  // §6.15). This app's prompt/temperature still diverge from the TS engines
  // (packages/engines); aligning them is deliberately out of scope here.
  private let systemPrompt = """
    You are a professional, native-level translator{SOURCE_HINT}. \
    Translate the user's text into {TARGET_LABEL}, producing a version that \
    reads as if originally written by a fluent native speaker — faithful, \
    natural, and idiomatic (信达雅).

    Rules:
    - Convey the meaning, not the words. Rewrite phrasing so it flows \
    naturally in {TARGET_LABEL}; never produce word-for-word or stiff, \
    machine-sounding output.
    - Match the register and tone of the original: casual stays casual, \
    formal stays formal. Do NOT over-formalize or "improve" the writing.
    - Use the target language's own idioms, word order, and punctuation \
    conventions rather than mirroring the source structure.
    - Preserve the original meaning, tone, paragraph breaks, and level of \
    formality.
    - Keep product names, brand names, person names, URLs, email addresses, \
    code, and file paths unchanged unless they have a widely accepted \
    localized form.
    - If part of the input is already in {TARGET_LABEL}, keep it natural and \
    do not comment on it.
    - Return only the translation. Do not add explanations, labels, notes, \
    or a preamble.
    """

  private static func langLabel(_ code: String) -> String {
    switch code.lowercased() {
    case "zh-cn", "zh-hans", "zh": return "Simplified Chinese"
    case "zh-tw", "zh-hant": return "Traditional Chinese"
    case "en": return "English"
    case "ja": return "Japanese"
    case "ko": return "Korean"
    case "fr": return "French"
    case "de": return "German"
    case "es": return "Spanish"
    case "ru": return "Russian"
    case "ar": return "Arabic"
    case "it": return "Italian"
    case "pt": return "Portuguese"
    case "th": return "Thai"
    case "vi": return "Vietnamese"
    case "id": return "Indonesian"
    case "hi": return "Hindi"
    case "tr": return "Turkish"
    case "nl": return "Dutch"
    case "pl": return "Polish"
    default: return code
    }
  }

  init() {
    let cfg = URLSessionConfiguration.default
    // Generous ceilings: long selections are chunked, but each chunk can
    // still take tens of seconds on a slow reasoning model, and the MT
    // fallbacks retry on 429/5xx within these bounds.
    cfg.timeoutIntervalForRequest = 60
    cfg.timeoutIntervalForResource = 180
    cfg.httpAdditionalHeaders = ["User-Agent": "LumenTranslation/0.1"]
    session = URLSession(configuration: cfg)
  }

  func translate(text: String, completion: @escaping (TranslationOutcome) -> Void) {
    let prefs = Preferences.shared
    let chunks = TranslationService.chunkForTranslation(text)
    let chain = fallbackChain(prefs: prefs)
    attempt(chain: chain, index: 0, chunks: chunks, prefs: prefs,
            lastError: "no translation provider available", completion: completion)
  }

  /// Ordered list of providers to try. The user's selection comes first, then
  /// the free keyless MT engines (Microsoft, Google), then any configured LLM
  /// (an `openai_compat` provider with an API key set). Duplicates and
  /// key-needing providers without a key are skipped.
  private func fallbackChain(prefs: Preferences) -> [ProviderPreset] {
    var chain: [ProviderPreset] = []
    var seen = Set<String>()
    func add(_ preset: ProviderPreset?) {
      guard let preset = preset, !seen.contains(preset.id) else { return }
      if preset.needsKey && prefs.apiKey(for: preset.id).isEmpty { return }
      chain.append(preset)
      seen.insert(preset.id)
    }
    add(prefs.provider)
    add(Providers.find("microsoft_translator"))
    add(Providers.find("google_translate"))
    // Any configured LLM: built-in catalog providers plus the user's custom
    // OpenAI-compatible endpoint slots (both surfaced via `allProviders`).
    for preset in prefs.allProviders where preset.apiStyle == "openai_compat" {
      add(preset)
    }
    return chain
  }

  /// Try providers in order, moving to the next on any failure and reporting
  /// the last error if all of them fail.
  private func attempt(chain: [ProviderPreset], index: Int, chunks: [String],
                       prefs: Preferences, lastError: String,
                       completion: @escaping (TranslationOutcome) -> Void) {
    guard index < chain.count else {
      completion(.failure(lastError))
      return
    }
    let preset = chain[index]
    attemptOne(preset: preset, chunks: chunks, prefs: prefs) { [weak self] outcome in
      switch outcome {
      case .success(let t, let engine, let detected):
        completion(.success(t, engine: engine, detectedLang: detected))
      case .failure(let e):
        let combined = "\(preset.label): \(e)"
        if index + 1 < chain.count {
          NSLog("[LumenTranslation] \(preset.id) failed (\(e)); falling back to \(chain[index + 1].id)")
        }
        self?.attempt(chain: chain, index: index + 1, chunks: chunks, prefs: prefs,
                      lastError: combined, completion: completion)
      }
    }
  }

  /// Route a whole (possibly chunked) selection through one provider. The two
  /// free MT engines get plain per-chunk calls; LLM providers additionally
  /// receive cross-chunk context. A failing chunk fails the provider, so the
  /// fallback chain moves on honestly instead of silently dropping the tail
  /// of the document.
  private func attemptOne(preset: ProviderPreset, chunks: [String], prefs: Preferences,
                          completion: @escaping (TranslationOutcome) -> Void) {
    let label = preset.label
    switch preset.apiStyle {
    case "google_translate":
      let endpoint = prefs.endpoint(for: preset)
      translateChunks(chunks, withContext: false, engineLabel: label) { input, done in
        self.googleTranslate(endpoint: endpoint, label: label, text: input.text,
                             source: prefs.sourceLang, target: prefs.targetLang,
                             completion: done)
      } completion: { outcome in
        completion(outcome)
      }
    case "microsoft_translator":
      let endpoint = prefs.endpoint(for: preset)
      translateChunks(chunks, withContext: false, engineLabel: label) { input, done in
        self.microsoftTranslate(endpoint: endpoint, label: label, text: input.text,
                                source: prefs.sourceLang, target: prefs.targetLang,
                                completion: done)
      } completion: { outcome in
        completion(outcome)
      }
    default:
      openAICompatibleTranslate(
        chunks: chunks,
        preset: preset,
        apiKey: prefs.apiKey(for: preset.id),
        model: prefs.model(for: preset.id),
        endpoint: prefs.endpoint(for: preset),
        source: prefs.sourceLang,
        target: prefs.targetLang,
        completion: completion)
    }
  }

  // MARK: - Google free endpoint

  private func googleTranslate(endpoint: String, label: String, text: String, source: String, target: String,
                               completion: @escaping (TranslationOutcome) -> Void) {
    guard var comps = URLComponents(string: endpoint) else {
      completion(.failure("google: bad endpoint \(endpoint)"))
      return
    }
    comps.queryItems = [
      URLQueryItem(name: "client", value: "gtx"),
      URLQueryItem(name: "dt", value: "t"),
      URLQueryItem(name: "sl", value: source),
      URLQueryItem(name: "tl", value: target),
      URLQueryItem(name: "q", value: text),
    ]
    runJSON(url: comps.url!) { result in
      switch result {
      case .success(let json):
        guard let arr = json as? [Any],
              let sentences = arr.first as? [[Any]] else {
          completion(.failure("google: unexpected response"))
          return
        }
        let out = sentences.compactMap { $0.first as? String }.joined()
        // The outer array's second element is the detected source language
        // when the request asked for auto-detection (e.g. "en", "zh-CN").
        var detected: String?
        if source == "auto", arr.count > 1,
           let d = arr[1] as? String, !d.isEmpty, !d.contains(" ") {
          detected = d
        }
        if out.isEmpty {
          completion(.failure("google: empty response"))
        } else {
          completion(.success(out, engine: label, detectedLang: detected))
        }
      case .failure(let e):
        completion(.failure(e.description))
      }
    }
  }

  // MARK: - Microsoft free endpoint (no key required)

  private func microsoftTranslate(endpoint: String, label: String, text: String, source: String, target: String,
                                  completion: @escaping (TranslationOutcome) -> Void) {
    let sl = source == "auto" ? "" : "&from=\(source)"
    let urlStr = "\(endpoint)?api-version=3.0\(sl)&to=\(target)"
    guard let url = URL(string: urlStr) else {
      completion(.failure("microsoft: bad URL"))
      return
    }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try? JSONSerialization.data(withJSONObject: [["Text": text]])
    runRequest(req) { result in
      switch result {
      case .success(let data):
        do {
          let arr = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []
          let out = (arr.first?["translations"] as? [[String: Any]])?
            .compactMap { $0["text"] as? String }.joined() ?? ""
          // When no `from` was sent, the response carries the detected
          // source language: [{"detectedLanguage":{"language":"en",...},...}].
          var detected: String?
          if source == "auto",
             let det = (arr.first?["detectedLanguage"] as? [String: Any])?["language"] as? String,
             !det.isEmpty {
            detected = det
          }
          if out.isEmpty {
            completion(.failure("microsoft: empty response"))
          } else {
            completion(.success(out, engine: label, detectedLang: detected))
          }
        } catch {
          completion(.failure("microsoft: \(error.localizedDescription)"))
        }
      case .failure(let e):
        completion(.failure(e.description))
      }
    }
  }

  // MARK: - Long-text chunking

  /// Split a long selection into order-preserving chunks of at most
  /// `maxChars` characters on paragraph boundaries (blank lines). A
  /// paragraph that is itself over the cap is hard-split on sentence
  /// boundaries, then word boundaries, then a final hard cut (e.g. a single
  /// giant code block). Chunk seams align with the `"\n\n"` separator the
  /// caller uses to join results, so paragraph structure survives
  /// round-trips whenever no hard split was needed. Empty paragraphs
  /// (double blank lines) are spacing inside the surrounding chunk and do
  /// not become seams. Internal (not private) so the smoke test can pin it.
  static func chunkForTranslation(_ text: String, maxChars: Int = 3000) -> [String] {
    if text.count <= maxChars { return [text] }
    var chunks: [String] = []
    var current = ""
    for paragraph in text.components(separatedBy: "\n\n") {
      if paragraph.isEmpty { continue }
      if current.isEmpty {
        current = paragraph
      } else if current.count + paragraph.count + 2 <= maxChars {
        current += "\n\n" + paragraph
      } else {
        chunks.append(current)
        current = paragraph
      }
    }
    if !current.isEmpty { chunks.append(current) }
    return chunks.flatMap {
      $0.count <= maxChars ? [$0] : splitOverlongPiece($0, maxChars: maxChars)
    }
  }

  private static func splitOverlongPiece(_ piece: String, maxChars: Int) -> [String] {
    var sentences: [String] = []
    piece.enumerateSubstrings(in: piece.startIndex..<piece.endIndex,
                              options: [.bySentences]) { sentence, _, _, _ in
      if let sentence { sentences.append(sentence) }
    }
    if sentences.isEmpty { sentences = [piece] }
    var chunks: [String] = []
    var current = ""
    for sentence in sentences {
      if current.isEmpty {
        current = sentence
      } else if current.count + sentence.count <= maxChars {
        current += sentence
      } else {
        chunks.append(current)
        current = sentence
      }
    }
    if !current.isEmpty { chunks.append(current) }
    return chunks.flatMap {
      $0.count <= maxChars ? [$0] : wrapAtWordBoundaries($0, maxChars: maxChars)
    }
  }

  private static func wrapAtWordBoundaries(_ chunk: String, maxChars: Int) -> [String] {
    var wrapped: [String] = []
    var buffer = ""
    for word in chunk.split(separator: " ") {
      let w = String(word)
      if buffer.isEmpty {
        buffer = w
      } else if buffer.count + w.count + 1 <= maxChars {
        buffer += " " + w
      } else {
        wrapped.append(buffer)
        buffer = w
      }
    }
    if !buffer.isEmpty { wrapped.append(buffer) }
    return wrapped.flatMap {
      $0.count <= maxChars ? [$0] : hardCut($0, maxChars: maxChars)
    }
  }

  private static func hardCut(_ s: String, maxChars: Int) -> [String] {
    var out: [String] = []
    var start = s.startIndex
    while start < s.endIndex {
      let end = s.index(start, offsetBy: maxChars, limitedBy: s.endIndex) ?? s.endIndex
      out.append(String(s[start..<end]))
      start = end
    }
    return out
  }

  /// One chunk being prepared for the network, plus the carry-over needed for
  /// consistency: the previous chunk's translation (LLM providers only) and
  /// the chunk's position in the sequence, used by `userContent`.
  private struct ChunkInput {
    let text: String
    let previousTranslation: String?
    let index: Int
    let count: Int
  }

  /// Translate `chunks` in order with `single`, joining results with blank
  /// lines so paragraph structure survives splitting. Any chunk failure
  /// fails the whole provider — a partial translation would silently drop
  /// the tail of the document, and the fallback chain should move on
  /// honestly instead. When `withContext` is true, each chunk after the
  /// first receives the previous chunk's translation (see `ChunkInput`),
  /// which LLM providers use for terminology consistency. The engine's
  /// detected source language is taken from the first chunk.
  private func translateChunks(
    _ chunks: [String],
    withContext: Bool,
    engineLabel: String,
    single: @escaping (ChunkInput, @escaping (TranslationOutcome) -> Void) -> Void,
    completion: @escaping (TranslationOutcome) -> Void
  ) {
    var parts: [String] = []
    var detectedLang: String?
    func step(_ i: Int, _ previous: String?) {
      guard i < chunks.count else {
        let joined = parts.joined(separator: "\n\n")
          .trimmingCharacters(in: .whitespacesAndNewlines)
        if joined.isEmpty {
          completion(.failure("empty response"))
        } else {
          completion(.success(joined, engine: engineLabel, detectedLang: detectedLang))
        }
        return
      }
      let input = ChunkInput(text: chunks[i], previousTranslation: previous,
                             index: i, count: chunks.count)
      single(input) { outcome in
        switch outcome {
        case .success(let t, _, let d):
          parts.append(t)
          if detectedLang == nil { detectedLang = d }
          step(i + 1, withContext ? t : nil)
        case .failure(let e):
          completion(.failure(e))
        }
      }
    }
    step(0, nil)
  }

  /// User message for one chunk of a split long text. Single-chunk texts
  /// (the normal PopClip case) go through verbatim. For multi-chunk texts,
  /// parts after the first add a part counter and the previous part's
  /// translation as read-only context, and the chunk to translate is
  /// delimited so the model translates exactly that block — the context
  /// must never leak into the output (the system prompt also demands
  /// "return only the translation").
  private static func userContent(for input: ChunkInput) -> String {
    guard input.count > 1 else { return input.text }
    let prefix = "This is part \(input.index + 1) of \(input.count). "
    if let previous = input.previousTranslation, !previous.isEmpty {
      return prefix
        + "For consistency, here is my translation of the previous part (do not re-translate or repeat it):\n"
        + previous.prefix(1200)
        + "\n\n--- Text to translate ---\n"
        + input.text
    }
    return prefix + "Translate the text below.\n\n--- Text to translate ---\n" + input.text
  }

  // MARK: - OpenAI-compatible chat completions (used by all LLM providers)

  private func openAICompatibleTranslate(
    chunks: [String],
    preset: ProviderPreset,
    apiKey: String,
    model: String,
    endpoint: String,
    source: String,
    target: String,
    completion: @escaping (TranslationOutcome) -> Void
  ) {
    guard !preset.needsKey || !apiKey.isEmpty else {
      completion(.failure("No API key set for \(preset.label). Open Lumen Translation menu bar → Settings to add one."))
      return
    }
    guard let url = URL(string: endpoint) else {
      completion(.failure("bad endpoint: \(endpoint)"))
      return
    }

    let targetLabel = TranslationService.langLabel(target)
    let sourceHint: String
    if source == "auto" || source.isEmpty {
      sourceHint = ""
    } else {
      sourceHint = " (from \(TranslationService.langLabel(source)))"
    }

    let system = systemPrompt
      .replacingOccurrences(of: "{TARGET_LABEL}", with: targetLabel)
      .replacingOccurrences(of: "{SOURCE_HINT}", with: sourceHint)

    translateChunks(chunks, withContext: true, engineLabel: preset.label) { input, done in
      var body: [String: Any] = [
        "model": model,
        "temperature": 0.3,
        "messages": [
          ["role": "system", "content": system],
          ["role": "user", "content": TranslationService.userContent(for: input)],
        ],
      ]
      // Data-driven "disable thinking" injection (catalog quirks.no_thinking):
      // reasoning models (e.g. MiniMax-M3, deepseek-reasoner) otherwise emit
      // chain-of-thought tokens, which slows translation down and wastes
      // tokens. Mirrors createProviderEngine in packages/engines/providers.ts.
      if let noThinking = preset.noThinkingInjection(for: model) {
        for (k, v) in noThinking { body[k] = v }
      }

      var req = URLRequest(url: url)
      req.httpMethod = "POST"
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      if preset.needsKey {
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
      }
      for (k, v) in preset.extraHeaders {
        req.setValue(v, forHTTPHeaderField: k)
      }
      // 3 KB chunks still take tens of seconds end-to-end on reasoning
      // models; the old 30 s cap is what failed on long selections.
      req.timeoutInterval = 120
      req.httpBody = try? JSONSerialization.data(withJSONObject: body)

      self.runRequest(req) { result in
        switch result {
        case .success(let data):
          do {
            let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
            if let err = json["error"] as? [String: Any], let msg = err["message"] as? String {
              // The fallback driver (`attempt`) prefixes the provider label, so
              // provider-internal messages stay label-free to avoid duplication.
              done(.failure(msg))
              return
            }
            let choices = json["choices"] as? [[String: Any]] ?? []
            let content = (choices.first?["message"] as? [String: Any])?["content"] as? String ?? ""
            let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
              done(.failure("empty response"))
            } else {
              // LLM providers don't report the detected source language, so the
              // window's swap button falls back to its default in that case.
              done(.success(trimmed, engine: preset.label, detectedLang: nil))
            }
          } catch {
            done(.failure(error.localizedDescription))
          }
        case .failure(let e):
          done(.failure(e.description))
        }
      }
    } completion: { outcome in
      completion(outcome)
    }
  }

  // MARK: - HTTP helpers

  private func runJSON(url: URL, completion: @escaping (Result<Any, TranslationError>) -> Void) {
    var req = URLRequest(url: url)
    req.timeoutInterval = 15
    runRequest(req) { result in
      switch result {
      case .success(let data):
        do {
          let json = try JSONSerialization.jsonObject(with: data)
          completion(.success(json))
        } catch {
          completion(.failure(.parse(error.localizedDescription)))
        }
      case .failure(let e):
        completion(.failure(e))
      }
    }
  }

  private func runRequest(_ req: URLRequest, completion: @escaping (Result<Data, TranslationError>) -> Void) {
    session.dataTask(with: req) { data, response, err in
      if let err = err {
        completion(.failure(.badRequest(err.localizedDescription)))
        return
      }
      guard let http = response as? HTTPURLResponse, let data = data else {
        completion(.failure(.badRequest("no response")))
        return
      }
      guard (200...299).contains(http.statusCode) else {
        let body = String(data: data, encoding: .utf8) ?? ""
        completion(.failure(.http(http.statusCode, body)))
        return
      }
      completion(.success(data))
    }.resume()
  }
}

// Translation service: routes to either Google's free endpoint or an
// OpenAI-compatible chat-completions provider based on user preferences.
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
    case .http(let code, let body): return "HTTP \(code): \(body)"
    case .parse(let m): return "parse error: \(m)"
    }
  }
}

enum TranslationOutcome {
  case success(String)
  case failure(String)
}

final class TranslationService {
  static let shared = TranslationService()

  private let session: URLSession
  private let googleSystemPrompt = """
    You are a professional translation engine. Translate the user's text \
    from {SOURCE} to {TARGET}. Return ONLY the translation, no explanations \
    or quotes. Preserve line breaks.
    """

  init() {
    let cfg = URLSessionConfiguration.default
    cfg.timeoutIntervalForRequest = 30
    cfg.timeoutIntervalForResource = 60
    cfg.httpAdditionalHeaders = ["User-Agent": "LumenWindow/0.1"]
    session = URLSession(configuration: cfg)
  }

  func translate(text: String, completion: @escaping (TranslationOutcome) -> Void) {
    let prefs = Preferences.shared
    let preset = prefs.provider
    switch preset.id {
    case "google":
      googleTranslate(text: text, source: prefs.sourceLang, target: prefs.targetLang, completion: completion)
    case "microsoft":
      microsoftTranslate(text: text, source: prefs.sourceLang, target: prefs.targetLang, completion: completion)
    default:
      openAICompatibleTranslate(
        text: text,
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

  private func googleTranslate(text: String, source: String, target: String,
                               completion: @escaping (TranslationOutcome) -> Void) {
    var comps = URLComponents(string: "https://translate.googleapis.com/translate_a/single")!
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
        completion(.success(out))
      case .failure(let e):
        completion(.failure(e.description))
      }
    }
  }

  // MARK: - Microsoft free endpoint (no key required)

  private func microsoftTranslate(text: String, source: String, target: String,
                                  completion: @escaping (TranslationOutcome) -> Void) {
    let sl = source == "auto" ? "" : "&from=\(source)"
    let urlStr = "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0\(sl)&to=\(target)"
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
          if out.isEmpty {
            completion(.failure("microsoft: empty response"))
          } else {
            completion(.success(out))
          }
        } catch {
          completion(.failure("microsoft: \(error.localizedDescription)"))
        }
      case .failure(let e):
        completion(.failure(e.description))
      }
    }
  }

  // MARK: - OpenAI-compatible chat completions (used by all LLM providers)

  private func openAICompatibleTranslate(
    text: String,
    preset: ProviderPreset,
    apiKey: String,
    model: String,
    endpoint: String,
    source: String,
    target: String,
    completion: @escaping (TranslationOutcome) -> Void
  ) {
    guard !preset.needsKey || !apiKey.isEmpty else {
      completion(.failure("No API key set for \(preset.label). Open LumenWindow → Preferences to add one."))
      return
    }
    guard let url = URL(string: endpoint) else {
      completion(.failure("bad endpoint: \(endpoint)"))
      return
    }

    let system = googleSystemPrompt
      .replacingOccurrences(of: "{SOURCE}", with: source == "auto" ? "the source language" : source)
      .replacingOccurrences(of: "{TARGET}", with: target)

    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if preset.needsKey {
      req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
    }
    for (k, v) in preset.extraHeaders {
      req.setValue(v, forHTTPHeaderField: k)
    }
    req.timeoutInterval = 30

    let body: [String: Any] = [
      "model": model,
      "temperature": 0,
      "messages": [
        ["role": "system", "content": system],
        ["role": "user", "content": text],
      ],
    ]
    req.httpBody = try? JSONSerialization.data(withJSONObject: body)

    runRequest(req) { result in
      switch result {
      case .success(let data):
        do {
          let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
          if let err = json["error"] as? [String: Any], let msg = err["message"] as? String {
            completion(.failure("\(preset.label): \(msg)"))
            return
          }
          let choices = json["choices"] as? [[String: Any]] ?? []
          let content = (choices.first?["message"] as? [String: Any])?["content"] as? String ?? ""
          let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
          if trimmed.isEmpty {
            completion(.failure("\(preset.label): empty response"))
          } else {
            completion(.success(trimmed))
          }
        } catch {
          completion(.failure("\(preset.label): \(error.localizedDescription)"))
        }
      case .failure(let e):
        completion(.failure(e.description))
      }
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

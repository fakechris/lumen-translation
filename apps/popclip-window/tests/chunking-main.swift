// Smoke test for the long-text chunking added to `TranslationService` (run
// via ../test-chunking.sh). Compiled as a plain CLI together with
// LLMService.swift / Preferences.swift / ProviderCatalog.swift so the method
// under test is the real shipped one. Pins the properties that fix the
// "long markdown selection times out" bug:
//   - short text passes through unchanged,
//   - paragraph boundaries are preserved (exact round-trip when no hard
//     split is needed),
//   - no chunk ever exceeds the cap, even for a single over-long
//     paragraph/code block or an unbreakable giant word.

import Foundation

var checks = 0
func check(_ cond: Bool, _ msg: String) {
  checks += 1
  if !cond {
    FileHandle.standardError.write("FAIL: \(msg)\n".data(using: .utf8)!)
    exit(1)
  }
}

@main
enum ChunkingTestMain {
  static func main() {
    // 1. Short text passes through untouched (the normal PopClip case).
    let short = "Hello, world."
    check(TranslationService.chunkForTranslation(short) == [short],
          "short text stays a single chunk")

    // 2. Paragraph-boundary split round-trips exactly via "\n\n", and every
    //    chunk stays under the cap.
    let paras = (1...12)
      .map { "Paragraph number \($0) with a realistic English sentence of reasonable length." }
      .joined(separator: "\n\n")
    let c2 = TranslationService.chunkForTranslation(paras, maxChars: 500)
    check(c2.count > 1, "long text splits into \(c2.count) chunks")
    check(c2.allSatisfy { $0.count <= 500 }, "paragraph chunks stay under the cap")
    check(c2.joined(separator: "\n\n") == paras, "paragraph chunks round-trip exactly")

    // 3. Markdown section headers stick with their content and round-trip.
    let md = "## Defects found by the comparison\n\nAll fixed.\n\n## Also corrected\n\nPrompt caching."
    let c3 = TranslationService.chunkForTranslation(md, maxChars: 1000)
    check(c3.joined(separator: "\n\n") == md, "markdown round-trips")
    check(c3[0].contains("## Defects"), "first chunk keeps its header")

    // 4. A single over-long paragraph with no blank lines is hard-split, and
    //    every piece stays under the cap.
    let blob = String(repeating: "0123456789abcdef ", count: 400)  // ~16k chars
    let c4 = TranslationService.chunkForTranslation(blob, maxChars: 1000)
    check(c4.count > 1, "unbroken paragraph splits into \(c4.count) chunks")
    check(c4.allSatisfy { $0.count <= 1000 }, "hard-split chunks stay under the cap")
    check(c4.allSatisfy { !$0.isEmpty }, "no empty chunks")

    // 5. An unbreakable word longer than the cap is hard-cut, and the
    //    concatenation reconstructs the original.
    let giant = String(repeating: "x", count: 2500)
    let c5 = TranslationService.chunkForTranslation(giant, maxChars: 1000)
    check(c5.allSatisfy { $0.count <= 1000 }, "giant word hard-cut under the cap")
    check(c5.joined() == giant, "giant word reconstructs exactly")

    // 6. The real-world default cap applies when maxChars is omitted.
    let docs = String(repeating: "word ", count: 5000)  // ~25k chars > 3000
    let c6 = TranslationService.chunkForTranslation(docs)
    check(c6.count > 1, "default-cap chunking splits a 25k-char selection")
    check(c6.allSatisfy { $0.count <= 3000 }, "default chunks stay under 3000 chars")

    print("OK: \(checks) checks passed (chunking)")
  }
}

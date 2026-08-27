// LumenTranslation — translation window for PopClip.
//
// Architecture:
//   - LSUIElement = true
//   - NSAppleScriptEnabled = true + OSAScriptingDefinition = LumenTranslation.sdef
//   - NSScriptCommand subclass TranslateCommand
//   - TranslateWindow : NSWindow (override initWithContentRect/styleMask,
//     constrainFrameRect, cancelOperation, close)
//   - TranslateWindowController : NSWindowController + NSWindowDelegate
//     (init, loadWindow, windowDidLoad, windowDidResignKey)
//
// PopClip action:  tell application "LumenTranslation" to translate "text"
//
// LLM providers (configured via Preferences window, opened from the status
// bar item) are driven by the vendored lumen-suite provider catalog (see
// ProviderCatalog.swift): Google / Microsoft (free), OpenAI, OpenRouter
// (incl. Claude), Kimi, GLM, MiniMax, DeepSeek. Region auto-detected.

import AppKit
import Carbon.HIToolbox
import Foundation

// MARK: - App entry

@main
enum LumenTranslationMain {
  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var reopenHotKey: GlobalHotKey?

  func applicationDidFinishLaunching(_ notification: Notification) {
    ProcessInfo.processInfo.disableAutomaticTermination("lumen-popclip-window")
    ProcessInfo.processInfo.disableSuddenTermination()

    // Global hotkey ⌥⌘L: re-show the last translation from any app, keeping
    // its original source + translation context.
    reopenHotKey = GlobalHotKey(keyCode: UInt32(kVK_ANSI_L),
                                modifiers: UInt32(cmdKey | optionKey)) {
      TranslateWindowController.shared.showLast()
    }
  }

  @objc private func showLastTranslation() {
    TranslateWindowController.shared.showLast()
  }

  @objc private func openPreferences() {
    PreferencesWindowController.show()
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    ProcessInfo.processInfo.enableSuddenTermination()
    ProcessInfo.processInfo.enableAutomaticTermination("lumen-popclip-window")
    return .terminateNow
  }
}

// MARK: - NSScriptCommand for AppleScript `translate` verb

final class TranslateCommand: NSScriptCommand {
  override func performDefaultImplementation() -> Any? {
    let text = (directParameter as? String) ?? ""
    let sem = DispatchSemaphore(value: 0)
    var resultTranslation = ""
    var resultEngine = ""
    var resultDetected: String?
    let prefs = Preferences.shared
    TranslationService.shared.translate(text: text) { outcome in
      switch outcome {
      case .success(let t, let engine, let detected):
        resultTranslation = t
        resultEngine = engine
        resultDetected = detected
      case .failure(let e):
        resultTranslation = "Lumen error: \(e)"
        resultEngine = "error"
      }
      sem.signal()
    }
    // Allow enough time for the fallback chain (primary + free MT + LLM) on
    // a long, chunked selection — a full document can take a couple of
    // minutes across several requests, especially with slow reasoning models.
    _ = sem.wait(timeout: .now() + 300)
    let payload = TranslationPayload(
      source: text, translation: resultTranslation,
      engine: resultEngine,
      sourceLang: prefs.sourceLang, targetLang: prefs.targetLang,
      detectedLang: resultDetected)
    NSLog("[LumenTranslation] cmd about to show, isMain=\(Thread.isMainThread)")
    TranslateWindowController.shared.show(payload: payload)
    NSLog("[LumenTranslation] cmd returned from show")
    return resultTranslation
  }
}

// MARK: - NSScriptCommand for AppleScript `configure` verb
//
// Receives a JSON record from PopClip with option overrides
// (engine/apiKey/model/region/sourceLang/targetLang). Values that are empty
// strings are treated as "PopClip didn't set this" and ignored, so the
// LumenTranslation Preferences UI remains the source of truth for those fields.

final class ConfigureCommand: NSScriptCommand {
  override func performDefaultImplementation() -> Any? {
    guard let json = (directParameter as? String)?.data(using: .utf8),
          let dict = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else {
      return "error: bad json"
    }
    let prefs = Preferences.shared
    if let v = dict["engine"] as? String, !v.isEmpty {
      prefs.providerId = v
    }
    // Only bind a key/model to a provider when PopClip actually names one.
    // With engine defaulting to "" ("App Setting"), the app's own per-provider
    // config stays authoritative and we avoid an orphaned "lumen.apiKey." write.
    if let v = dict["apiKey"] as? String, !v.isEmpty,
       let pid = dict["engine"] as? String, !pid.isEmpty {
      prefs.setApiKey(v, for: pid)
    }
    if let v = dict["model"] as? String, !v.isEmpty,
       let pid = dict["engine"] as? String, !pid.isEmpty {
      prefs.setModel(v, for: pid)
    }
    if let v = dict["region"] as? String, !v.isEmpty {
      prefs.regionOverride = v == "auto" ? nil : v
    }
    if let v = dict["sourceLang"] as? String, !v.isEmpty {
      prefs.sourceLang = v
    }
    if let v = dict["targetLang"] as? String, !v.isEmpty {
      prefs.targetLang = v
    }
    NSLog("[LumenTranslation] configure applied: engine=\(prefs.providerId) region=\(prefs.regionOverride ?? "auto")")
    return "ok"
  }
}

struct TranslationPayload {
  var source: String
  var translation: String
  var engine: String
  var sourceLang: String
  var targetLang: String
  /// Engine-reported source language when the requested source was "auto"
  /// (nil for explicit sources and LLM providers).
  var detectedLang: String?
}

// MARK: - TranslateWindow : NSWindow

final class TranslateWindow: NSWindow {
  override init(contentRect: NSRect, styleMask style: NSWindow.StyleMask,
                backing backingStoreType: NSWindow.BackingStoreType,
                defer flag: Bool) {
    // Borderless, transparent, floating — set in init.
    let mask: NSWindow.StyleMask = [.borderless, .fullSizeContentView]
    super.init(contentRect: contentRect, styleMask: mask,
               backing: backingStoreType, defer: flag)
    self.titleVisibility = .hidden
    self.titlebarAppearsTransparent = true
    self.isOpaque = false
    self.backgroundColor = .clear
    self.hasShadow = true
    self.level = .floating
    self.isMovableByWindowBackground = true
    self.hidesOnDeactivate = false
    self.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
    self.isReleasedWhenClosed = false
  }

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  // Keep the window on-screen.
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
    guard let screen = screen ?? NSScreen.main else { return frameRect }
    let vf = screen.visibleFrame
    var f = frameRect
    if f.origin.x < vf.minX { f.origin.x = vf.minX }
    if f.origin.x + f.width > vf.maxX { f.origin.x = vf.maxX - f.width }
    if f.origin.y < vf.minY { f.origin.y = vf.minY }
    if f.origin.y + f.height > vf.maxY { f.origin.y = vf.maxY - f.height }
    return f
  }

  // Esc closes (hides) the window.
  override func cancelOperation(_ sender: Any?) {
    orderOut(nil)
  }

  // ⌘W closes (hides) the window. There's no menu bar for this borderless
  // window, so handle the key equivalent directly.
  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
    if flags == .command, event.charactersIgnoringModifiers?.lowercased() == "w" {
      orderOut(nil)
      return true
    }
    return super.performKeyEquivalent(with: event)
  }

  override func close() {
    super.close()
  }
}

// MARK: - TranslateWindowController

final class TranslateWindowController: NSWindowController, NSWindowDelegate {
  static let shared = TranslateWindowController()

  // True while an NSMenu is being tracked (e.g. the language-selector popups
  // in the window). Used to keep the window open when it momentarily resigns
  // key status during menu tracking — otherwise the click that opens a popup
  // would also close the window via windowDidResignKey.
  static var menuTracking = false

  private var contentView: TranslateContentView?
  // Kept in memory so ⌥⌘L / "Show Last Translation" can re-open the window
  // with its previous source + translation after it's been closed.
  private var lastPayload: TranslationPayload?

  private override init(window: NSWindow?) {
    super.init(window: window)
  }

  required init?(coder: NSCoder) { fatalError() }

  override func windowDidLoad() {
    super.windowDidLoad()
  }

  func show(payload: TranslationPayload) {
    NSLog("[LumenTranslation] show() enter isMain=\(Thread.isMainThread)")
    lastPayload = payload
    if self.window == nil {
      NSLog("[LumenTranslation] creating window")
      // Fixed width 400. Height is computed below from content
      // with a hard cap, so long text scrolls inside the text views rather
      // than making the window arbitrarily tall.
      let rect = NSRect(x: 0, y: 0, width: 400, height: 280)
      let w = TranslateWindow(contentRect: rect,
                              styleMask: [.borderless, .fullSizeContentView],
                              backing: .buffered, defer: false)
      let cv = TranslateContentView(frame: NSRect(x: 0, y: 0, width: 400, height: 280))
      cv.autoresizingMask = [.width, .height]
      w.contentView = cv
      w.delegate = self
      self.contentView = cv
      // In-window language switches re-translate and can change the
      // translation height, so the content asks us to re-fit the frame.
      cv.onRefitNeeded = { [weak self] in self?.layoutWindow() }
      self.window = w
    }
    guard let w = self.window, let cv = self.contentView else {
      NSLog("[LumenTranslation] no window or contentView!")
      return
    }
    cv.update(payload: payload)

    // Activate the app first, then show.
    NSApp.activate(ignoringOtherApps: true)

    layoutWindow()

    showWindow(self)
    w.makeKeyAndOrderFront(nil)
    NSLog("[LumenTranslation] window after show frame=\(w.frame) isVisible=\(w.isVisible)")
  }

  // Recompute the window frame from the content's current text heights.
  // Called when a new payload is shown and after an in-window language
  // switch / swap, where the translation height can change. Width is fixed at
  // 400; height grows with content and the internal text views scroll once
  // text exceeds the available screen height.
  private func layoutWindow() {
    guard let w = self.window, let cv = self.contentView else { return }
    let width = 400
    cv.setTextContainerWidth(CGFloat(width - 32))
    let srcH = cv.sourceTextHeight
    let trH = cv.translationTextHeight
    // Cap each text view's height to fit within the screen, scrolling inside.
    let screenH = NSScreen.main?.visibleFrame.height ?? 800
    let maxSrc = min(srcH, screenH * 0.35)
    let maxTr = min(trH, screenH * 0.45)
    cv.setScrollHeights(source: maxSrc, translation: maxTr)
    // Layout: 40 header (language bar) + src + 12 + 1 (divider) + 12 + tr
    //         + 14 + 24 (button row) + 16 bottom
    let height = max(280, 40 + maxSrc + 12 + 1 + 12 + maxTr + 14 + 24 + 16)
    NSLog("[LumenTranslation] height src=\(srcH) tr=\(trH) final=\(height)")

    if let screen = NSScreen.main {
      let vf = screen.visibleFrame
      let h = min(height, vf.height - 40)
      let x = vf.midX - CGFloat(width) / 2
      let y = vf.midY + vf.height * 0.15
      let f = w.constrainFrameRect(
        NSRect(x: x, y: y, width: CGFloat(width), height: h),
        to: screen)
      w.setFrame(f, display: true)
    }
  }

  // Re-open the most recent translation (⌥⌘L / status-menu item). Beeps if
  // there's nothing to show yet.
  func showLast() {
    guard let payload = lastPayload else {
      NSSound.beep()
      return
    }
    show(payload: payload)
  }

  // Close (hide) the window when the user clicks outside it. The window and
  // its content are retained (isReleasedWhenClosed = false), so the last
  // translation can be re-opened with ⌥⌘L.
  // While a menu (e.g. the language popups) is being tracked the window may
  // momentarily resign key status; don't close then, the selection is still
  // in progress.
  func windowDidResignKey(_ notification: Notification) {
    guard !TranslateWindowController.menuTracking else { return }
    window?.orderOut(nil)
  }
}


// MARK: - Content view (AppKit: fixed width, scrollable text)

final class TranslateContentView: NSView {
  private let sourceScrollView = NSScrollView()
  private let translationScrollView = NSScrollView()
  private let sourceTextView = TranslateContentView.makeTextView()
  private let translationTextView = TranslateContentView.makeTextView()
  private let engineLabel = NSTextField(labelWithString: "")
  private let statusLabel = NSTextField(labelWithString: "")
  private let copyButton = NSButton()
  private let speakButton = NSButton()
  private let closeButton = NSButton()
  private let divider = NSBox()
  // Bob-style quick language switcher: [source ▾] ⇄ [target ▾].
  private let sourceLangPopup = NSPopUpButton(frame: .zero, pullsDown: false)
  private let targetLangPopup = NSPopUpButton(frame: .zero, pullsDown: false)
  private let swapButton = NSButton()
  private var currentTranslation = ""
  private var copiedTimer: Timer?
  // Guards against recursive scroll sync.
  private var syncing = false
  // Engine-reported source language for the currently shown text, used by the
  // swap button to reverse auto-detect sources (nil when the source was
  // explicit or the engine can't detect, e.g. LLM providers).
  private var lastDetectedLang: String?
  // Bumped per retranslate; stale async completions are ignored so a fast
  // series of language switches always lands on the latest selection.
  private var translateGeneration = 0
  /// Called after an in-window language switch finishes re-translating so the
  /// controller can re-fit the window height to the new result.
  var onRefitNeeded: (() -> Void)?

  // MARK: - Palette (Lumen "Atelier" warm parchment)

  private static let warmSecondary =
    NSColor(srgbRed: 0x71/255, green: 0x67/255, blue: 0x5d/255, alpha: 1)
  private static let warmAccent =
    NSColor(srgbRed: 0x9f/255, green: 0x4f/255, blue: 0x24/255, alpha: 1)

  // Force-generate glyphs for the current text at the given container width
  // so we can measure the real laid-out height.
  func setTextContainerWidth(_ width: CGFloat) {
    [sourceTextView, translationTextView].forEach {
      $0.textContainer?.widthTracksTextView = false
      $0.textContainer?.size = NSSize(width: width, height: CGFloat.greatestFiniteMagnitude)
      $0.layoutManager?.ensureLayout(for: $0.textContainer!)
    }
  }

  var sourceTextHeight: CGFloat {
    let tc = sourceTextView.textContainer!
    let lm = sourceTextView.layoutManager!
    lm.ensureLayout(for: tc)
    return lm.usedRect(for: tc).height
  }

  var translationTextHeight: CGFloat {
    let tc = translationTextView.textContainer!
    let lm = translationTextView.layoutManager!
    lm.ensureLayout(for: tc)
    return lm.usedRect(for: tc).height
  }

  // Explicitly size the scroll views so each text area is fully visible when
  // short, and scrollable when it exceeds `maxSource` / `maxTranslation`.
  // Uses mutable height constraints (created in setup) rather than fighting
  // auto-layout with manual frames.
  private var sourceHeightC: NSLayoutConstraint?
  private var translationHeightC: NSLayoutConstraint?

  func setScrollHeights(source: CGFloat, translation: CGFloat) {
    sourceHeightC?.constant = source
    translationHeightC?.constant = translation
    layoutSubtreeIfNeeded()
  }

  private static func makeTextView() -> NSTextView {
    let tv = NSTextView()
    tv.isEditable = false
    tv.isSelectable = true
    tv.isRichText = false
    tv.drawsBackground = false
    tv.textContainerInset = NSSize(width: 0, height: 0)
    tv.textContainer?.lineFragmentPadding = 0
    tv.textContainer?.widthTracksTextView = false
    tv.textContainer?.size = NSSize(width: 368, height: CGFloat.greatestFiniteMagnitude)
    tv.autoresizingMask = [.width]
    tv.isVerticallyResizable = true
    tv.textContainer?.heightTracksTextView = false
    return tv
  }

  override init(frame frameRect: NSRect) {
    super.init(frame: frameRect)
    setup()
  }
  required init?(coder: NSCoder) { fatalError() }

  private func setup() {
    wantsLayer = true
    layer?.cornerRadius = 16
    layer?.masksToBounds = true
    // Lumen Design System "Atelier" warm parchment surface.
    layer?.backgroundColor = NSColor(srgbRed: 0xff/255, green: 0xfd/255, blue: 0xfa/255, alpha: 1).cgColor
    layer?.borderWidth = 1.0
    layer?.borderColor = NSColor(srgbRed: 0xe7/255, green: 0xe1/255, blue: 0xd8/255, alpha: 1).cgColor

    sourceScrollView.documentView = sourceTextView
    sourceScrollView.hasVerticalScroller = true
    sourceScrollView.autohidesScrollers = true
    sourceScrollView.drawsBackground = false
    sourceScrollView.borderType = .noBorder
    sourceScrollView.translatesAutoresizingMaskIntoConstraints = false
    sourceScrollView.contentView.postsBoundsChangedNotifications = true
    NotificationCenter.default.addObserver(
      self, selector: #selector(sourceBoundsChanged),
      name: NSView.boundsDidChangeNotification, object: sourceScrollView.contentView)

    translationScrollView.documentView = translationTextView
    translationScrollView.hasVerticalScroller = true
    translationScrollView.autohidesScrollers = true
    translationScrollView.drawsBackground = false
    translationScrollView.borderType = .noBorder
    translationScrollView.translatesAutoresizingMaskIntoConstraints = false

    sourceTextView.font = .systemFont(ofSize: 14, weight: .regular)
    sourceTextView.textColor = NSColor(srgbRed: 0x44/255, green: 0x3a/255, blue: 0x32/255, alpha: 1)
    translationTextView.font = .systemFont(ofSize: 14, weight: .regular)
    translationTextView.textColor = NSColor(srgbRed: 0x1f/255, green: 0x1a/255, blue: 0x17/255, alpha: 1)

    engineLabel.font = .systemFont(ofSize: 11, weight: .medium)
    engineLabel.textColor = NSColor(srgbRed: 0x71/255, green: 0x67/255, blue: 0x5d/255, alpha: 1)
    engineLabel.translatesAutoresizingMaskIntoConstraints = false

    statusLabel.font = .systemFont(ofSize: 11, weight: .medium)
    statusLabel.textColor = NSColor(srgbRed: 0x2f/255, green: 0x7d/255, blue: 0x52/255, alpha: 1)
    statusLabel.translatesAutoresizingMaskIntoConstraints = false
    statusLabel.isHidden = true

    closeButton.bezelStyle = .inline
    closeButton.image = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: "Close")
    closeButton.imagePosition = .imageOnly
    closeButton.font = .systemFont(ofSize: 14)
    closeButton.contentTintColor = NSColor(srgbRed: 0x71/255, green: 0x67/255, blue: 0x5d/255, alpha: 1)
    closeButton.target = self
    closeButton.action = #selector(closeAction)
    closeButton.translatesAutoresizingMaskIntoConstraints = false
    closeButton.isBordered = false

    copyButton.title = "Copy"
    copyButton.bezelStyle = .inline
    copyButton.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: "Copy")
    copyButton.imagePosition = .imageLeft
    copyButton.font = .systemFont(ofSize: 12)
    copyButton.target = self
    copyButton.action = #selector(copyAction)
    copyButton.translatesAutoresizingMaskIntoConstraints = false
    copyButton.isBordered = false

    speakButton.title = "Speak"
    speakButton.bezelStyle = .inline
    speakButton.image = NSImage(systemSymbolName: "speaker.wave.2", accessibilityDescription: "Speak")
    speakButton.imagePosition = .imageLeft
    speakButton.font = .systemFont(ofSize: 12)
    speakButton.target = self
    speakButton.action = #selector(speakAction)
    speakButton.translatesAutoresizingMaskIntoConstraints = false
    speakButton.isBordered = false

    // Quick language switcher ([source ▾] ⇄ [target ▾], Bob-style). The
    // source popup lists auto-detect first; the target popup only concrete
    // languages. Picking either re-translates immediately.
    configureLangPopup(sourceLangPopup, options: LanguageCatalog.sourceOptions,
                       tint: TranslateContentView.warmSecondary,
                       action: #selector(sourceLangChanged))
    configureLangPopup(targetLangPopup, options: LanguageCatalog.targetOptions,
                       tint: TranslateContentView.warmAccent,
                       action: #selector(targetLangChanged))

    swapButton.image = NSImage(systemSymbolName: "arrow.left.arrow.right",
                               accessibilityDescription: "Swap languages")
    swapButton.imagePosition = .imageOnly
    swapButton.isBordered = false
    swapButton.bezelStyle = .inline
    swapButton.contentTintColor = TranslateContentView.warmSecondary
    swapButton.target = self
    swapButton.action = #selector(swapAction)
    swapButton.toolTip = "Swap source and target language"
    swapButton.translatesAutoresizingMaskIntoConstraints = false

    // Don't auto-close the window while a language menu is open: opening an
    // NSPopUpButton menu can momentarily resign the window's key status, and
    // windowDidResignKey otherwise hides the window mid-selection.
    NotificationCenter.default.addObserver(
      self, selector: #selector(menuTrackingBegan),
      name: NSMenu.didBeginTrackingNotification, object: nil)
    NotificationCenter.default.addObserver(
      self, selector: #selector(menuTrackingEnded),
      name: NSMenu.didEndTrackingNotification, object: nil)

    divider.boxType = .separator
    divider.translatesAutoresizingMaskIntoConstraints = false

    addSubview(sourceLangPopup)
    addSubview(swapButton)
    addSubview(targetLangPopup)
    addSubview(sourceScrollView)
    addSubview(divider)
    addSubview(translationScrollView)
    addSubview(copyButton)
    addSubview(speakButton)
    addSubview(statusLabel)
    addSubview(engineLabel)
    addSubview(closeButton)

    let srcC = sourceScrollView.heightAnchor.constraint(equalToConstant: 60)
    let trC = translationScrollView.heightAnchor.constraint(equalToConstant: 120)
    srcC.priority = .required
    trC.priority = .required
    self.sourceHeightC = srcC
    self.translationHeightC = trC

    NSLayoutConstraint.activate([
      // Language switcher bar. The popups size to their titles; the target
      // popup may not grow into the close button in the top-right corner.
      sourceLangPopup.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
      sourceLangPopup.centerYAnchor.constraint(equalTo: topAnchor, constant: 21),

      swapButton.leadingAnchor.constraint(equalTo: sourceLangPopup.trailingAnchor, constant: 4),
      swapButton.centerYAnchor.constraint(equalTo: sourceLangPopup.centerYAnchor),
      swapButton.widthAnchor.constraint(equalToConstant: 26),

      targetLangPopup.leadingAnchor.constraint(equalTo: swapButton.trailingAnchor, constant: 4),
      targetLangPopup.centerYAnchor.constraint(equalTo: sourceLangPopup.centerYAnchor),
      targetLangPopup.trailingAnchor.constraint(lessThanOrEqualTo: closeButton.leadingAnchor, constant: -8),

      sourceScrollView.topAnchor.constraint(equalTo: topAnchor, constant: 40),
      sourceScrollView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      sourceScrollView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
      srcC,

      divider.topAnchor.constraint(equalTo: sourceScrollView.bottomAnchor, constant: 12),
      divider.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      divider.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),

      translationScrollView.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 12),
      translationScrollView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      translationScrollView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
      trC,

      copyButton.topAnchor.constraint(equalTo: translationScrollView.bottomAnchor, constant: 14),
      copyButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      copyButton.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -14),

      speakButton.centerYAnchor.constraint(equalTo: copyButton.centerYAnchor),
      speakButton.leadingAnchor.constraint(equalTo: copyButton.trailingAnchor, constant: 14),

      statusLabel.centerYAnchor.constraint(equalTo: copyButton.centerYAnchor),
      statusLabel.leadingAnchor.constraint(equalTo: speakButton.trailingAnchor, constant: 8),

      engineLabel.centerYAnchor.constraint(equalTo: copyButton.centerYAnchor),
      engineLabel.leadingAnchor.constraint(equalTo: speakButton.trailingAnchor, constant: 8),

      closeButton.topAnchor.constraint(equalTo: topAnchor, constant: 6),
      closeButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
      closeButton.widthAnchor.constraint(equalToConstant: 22),
      closeButton.heightAnchor.constraint(equalToConstant: 22),
    ])
  }

  // MARK: - Quick language switcher

  private func configureLangPopup(_ popup: NSPopUpButton, options: [LanguageOption],
                                  tint: NSColor, action: Selector) {
    popup.isBordered = false
    popup.bezelStyle = .inline
    popup.font = .systemFont(ofSize: 12, weight: .medium)
    popup.target = self
    popup.action = action
    popup.translatesAutoresizingMaskIntoConstraints = false
    popup.menu?.removeAllItems()
    let attrs: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 12, weight: .medium),
      .foregroundColor: tint,
    ]
    for opt in options {
      let item = NSMenuItem(title: opt.label, action: nil, keyEquivalent: "")
      item.representedObject = opt.code
      item.attributedTitle = NSAttributedString(string: opt.label, attributes: attrs)
      popup.menu?.addItem(item)
    }
  }

  private func selectLang(_ popup: NSPopUpButton, code: String) {
    let normalized = code.isEmpty ? LanguageCatalog.auto : code
    for item in popup.menu?.items ?? [] {
      if (item.representedObject as? String) == normalized {
        popup.select(item)
        return
      }
    }
    popup.selectItem(at: 0)
  }

  @objc private func sourceLangChanged() {
    guard let code = sourceLangPopup.selectedItem?.representedObject as? String else { return }
    Preferences.shared.sourceLang = code
    retranslateCurrent()
  }

  @objc private func targetLangChanged() {
    guard let code = targetLangPopup.selectedItem?.representedObject as? String else { return }
    Preferences.shared.targetLang = code
    retranslateCurrent()
  }

  @objc private func swapAction() {
    let prefs = Preferences.shared
    let oldSource = prefs.sourceLang
    let oldTarget = prefs.targetLang
    // Reverse the pair: the old target becomes the explicit source, the old
    // source becomes the target. When the source was auto-detect, use the
    // language the engine detected for the current text so 中文→English
    // reverses back to English→中文. Engines that don't report detection
    // (LLM providers) fall back to English.
    let newSource = oldTarget
    let newTarget = oldSource == LanguageCatalog.auto
      ? (lastDetectedLang ?? "en")
      : oldSource
    prefs.sourceLang = newSource
    prefs.targetLang = newTarget
    selectLang(sourceLangPopup, code: newSource)
    selectLang(targetLangPopup, code: newTarget)
    retranslateCurrent()
  }

  /// Re-run the translation with the currently selected languages and update
  /// the result in place — the "instant" switch from Bob's window. Stale
  /// completions from earlier switches are dropped via translateGeneration.
  private func retranslateCurrent() {
    let text = sourceTextView.string
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    translateGeneration += 1
    let gen = translateGeneration

    engineLabel.isHidden = true
    statusLabel.stringValue = "Translating…"
    statusLabel.isHidden = false

    TranslationService.shared.translate(text: text) { [weak self] outcome in
      DispatchQueue.main.async {
        guard let self = self, gen == self.translateGeneration else { return }
        switch outcome {
        case .success(let t, let engine, let detected):
          self.translationTextView.string = t
          self.currentTranslation = t
          self.lastDetectedLang = detected
          self.engineLabel.stringValue = engine
        case .failure(let e):
          // Show the message in the selectable translation area so it can be
          // read and copied (e.g. "No API key set for X.").
          self.translationTextView.string = "Lumen error: \(e)"
          self.currentTranslation = ""
          self.engineLabel.stringValue = "error"
        }
        self.engineLabel.isHidden = false
        self.statusLabel.isHidden = true
        self.needsLayout = true
        self.onRefitNeeded?()
      }
    }
  }

  @objc private func menuTrackingBegan() {
    TranslateWindowController.menuTracking = true
  }

  @objc private func menuTrackingEnded() {
    TranslateWindowController.menuTracking = false
  }

  func update(payload: TranslationPayload) {
    sourceTextView.string = payload.source
    translationTextView.string = payload.translation
    engineLabel.stringValue = payload.engine
    currentTranslation = payload.translation
    lastDetectedLang = payload.detectedLang
    // Keep the quick switcher and Preferences in sync with the payload
    // (PopClip options or a re-shown last translation).
    Preferences.shared.sourceLang = payload.sourceLang
    Preferences.shared.targetLang = payload.targetLang
    selectLang(sourceLangPopup, code: payload.sourceLang)
    selectLang(targetLangPopup, code: payload.targetLang)
    // A new payload supersedes any in-flight in-window re-translation.
    translateGeneration += 1
    copiedTimer?.invalidate()
    statusLabel.isHidden = true
    engineLabel.isHidden = false
    needsLayout = true
  }

  @objc private func copyAction() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(currentTranslation, forType: .string)
    statusLabel.stringValue = "Copied"
    statusLabel.isHidden = false
    engineLabel.isHidden = true
    copiedTimer?.invalidate()
    copiedTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
      self?.statusLabel.isHidden = true
      self?.engineLabel.isHidden = false
    }
  }

  @objc private func speakAction() {
    NSSpeechSynthesizer().startSpeaking(currentTranslation)
  }

  @objc private func closeAction() {
    // Close the enclosing window immediately (no need to wait for the
    // auto-hide timer).
    self.window?.orderOut(nil)
  }

  // MARK: - Linked scrolling

  // When the source view scrolls, the translation view scrolls proportionally.
  // Scrolling the translation view does NOT move the source (one-way sync).
  @objc private func sourceBoundsChanged() {
    guard !syncing else { return }
    let src = sourceScrollView
    let dst = translationScrollView
    let sDoc = src.documentView!.bounds.height - src.contentView.bounds.height
    guard sDoc > 1 else { return }
    let ratio = max(0, min(1, src.contentView.bounds.origin.y / sDoc))
    let dDoc = dst.documentView!.bounds.height - dst.contentView.bounds.height
    guard dDoc > 1 else { return }
    let target = ratio * dDoc
    syncing = true
    dst.contentView.bounds.origin.y = target
    syncing = false
  }
}

private extension NSLayoutConstraint {
  func withPriority(_ p: Float) -> NSLayoutConstraint {
    self.priority = NSLayoutConstraint.Priority(rawValue: p)
    return self
  }
}

// MARK: - Global hotkey (Carbon)
//
// RegisterEventHotKey installs a system-wide hotkey without needing the
// Accessibility permission and consumes the key event. Used for ⌥⌘L to
// re-open the last translation from any application.

final class GlobalHotKey {
  private var hotKeyRef: EventHotKeyRef?
  private var eventHandler: EventHandlerRef?
  private let id: UInt32
  private static var nextID: UInt32 = 1
  private static var handlers: [UInt32: () -> Void] = [:]

  init?(keyCode: UInt32, modifiers: UInt32, action: @escaping () -> Void) {
    id = GlobalHotKey.nextID
    GlobalHotKey.nextID += 1
    GlobalHotKey.handlers[id] = action

    var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                  eventKind: UInt32(kEventHotKeyPressed))
    let installStatus = InstallEventHandler(
      GetApplicationEventTarget(),
      { (_, event, _) -> OSStatus in
        var hkID = EventHotKeyID()
        GetEventParameter(event, EventParamName(kEventParamDirectObject),
                          EventParamType(typeEventHotKeyID), nil,
                          MemoryLayout<EventHotKeyID>.size, nil, &hkID)
        GlobalHotKey.handlers[hkID.id]?()
        return noErr
      },
      1, &eventType, nil, &eventHandler)
    guard installStatus == noErr else {
      GlobalHotKey.handlers[id] = nil
      return nil
    }

    let hotKeyID = EventHotKeyID(signature: OSType(0x4C554D4E), id: id) // 'LUMN'
    let status = RegisterEventHotKey(keyCode, modifiers, hotKeyID,
                                     GetApplicationEventTarget(), 0, &hotKeyRef)
    guard status == noErr else {
      if let eventHandler { RemoveEventHandler(eventHandler) }
      GlobalHotKey.handlers[id] = nil
      return nil
    }
  }

  deinit {
    if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
    if let eventHandler { RemoveEventHandler(eventHandler) }
    GlobalHotKey.handlers[id] = nil
  }
}

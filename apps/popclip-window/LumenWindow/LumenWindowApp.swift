// LumenWindow — Bob-style translation window for PopClip.
//
// Architecture mirrors /Applications/Bob.app (verified via otool -ov):
//   - LSUIElement = true
//   - NSAppleScriptEnabled = true + OSAScriptingDefinition = LumenWindow.sdef
//   - NSScriptCommand subclass TranslateCommand (like Bob.ASTranslateCommand)
//   - TranslateWindow : NSWindow (override initWithContentRect/styleMask,
//     constrainFrameRect, cancelOperation, close)
//   - TranslateWindowController : NSWindowController + NSWindowDelegate
//     (init, loadWindow, windowDidLoad, windowDidResignKey)
//
// PopClip action:  tell application "LumenWindow" to translate "text"
//
// LLM providers (configured via Preferences window, opened from the status
// bar item): Google / Microsoft (free), OpenAI, Anthropic via OpenRouter,
// Kimi, GLM, MiniMax, DeepSeek. Region (China vs overseas) auto-detected.

import AppKit
import Foundation

// MARK: - App entry

@main
enum LumenWindowMain {
  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!

  func applicationDidFinishLaunching(_ notification: Notification) {
    ProcessInfo.processInfo.disableAutomaticTermination("lumen-popclip-window")
    ProcessInfo.processInfo.disableSuddenTermination()

    // Status bar item: since LSUIElement apps have no Dock icon or app menu,
    // we expose Preferences + Quit via NSStatusItem.
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    if let btn = statusItem.button {
      let icon = NSImage(contentsOfFile: Bundle.main.path(forResource: "statusicon", ofType: "png") ?? "")
      if let icon {
        icon.size = NSSize(width: 18, height: 18)
        icon.isTemplate = true
        btn.image = icon
      } else {
        btn.image = NSImage(systemSymbolName: "character.bubble", accessibilityDescription: "Lumen")
      }
    }
    let menu = NSMenu()
    let prefsItem = menu.addItem(withTitle: "Preferences…", action: #selector(openPreferences), keyEquivalent: ",")
    prefsItem.target = self
    menu.addItem(NSMenuItem.separator())
    let quitItem = menu.addItem(withTitle: "Quit Lumen Translation", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    quitItem.target = NSApplication.shared
    statusItem.menu = menu
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
    let prefs = Preferences.shared
    let providerLabel = prefs.provider.label
    TranslationService.shared.translate(text: text) { outcome in
      switch outcome {
      case .success(let t):
        resultTranslation = t
        resultEngine = providerLabel
      case .failure(let e):
        resultTranslation = "Lumen error: \(e)"
        resultEngine = "error"
      }
      sem.signal()
    }
    _ = sem.wait(timeout: .now() + 30)
    let payload = TranslationPayload(
      source: text, translation: resultTranslation,
      engine: resultEngine,
      sourceLang: prefs.sourceLang, targetLang: prefs.targetLang)
    NSLog("[LumenWindow] cmd about to show, isMain=\(Thread.isMainThread)")
    TranslateWindowController.shared.show(payload: payload)
    NSLog("[LumenWindow] cmd returned from show")
    return resultTranslation
  }
}

// MARK: - NSScriptCommand for AppleScript `configure` verb
//
// Receives a JSON record from PopClip with option overrides
// (engine/apiKey/model/region/sourceLang/targetLang). Values that are empty
// strings are treated as "PopClip didn't set this" and ignored, so the
// LumenWindow Preferences UI remains the source of truth for those fields.

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
    if let v = dict["apiKey"] as? String, !v.isEmpty, let pid = dict["engine"] as? String {
      prefs.setApiKey(v, for: pid)
    }
    if let v = dict["model"] as? String, !v.isEmpty, let pid = dict["engine"] as? String {
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
    NSLog("[LumenWindow] configure applied: engine=\(prefs.providerId) region=\(prefs.regionOverride ?? "auto")")
    return "ok"
  }
}

struct TranslationPayload {
  var source: String
  var translation: String
  var engine: String
  var sourceLang: String
  var targetLang: String
}

// MARK: - TranslateWindow : NSWindow  (mirrors Bob.TranslateWindow)

final class TranslateWindow: NSWindow {
  override init(contentRect: NSRect, styleMask style: NSWindow.StyleMask,
                backing backingStoreType: NSWindow.BackingStoreType,
                defer flag: Bool) {
    // Borderless, transparent, floating — set in init like Bob does.
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

  // Keep the window on-screen (mirrors Bob's constrainFrameRect:toScreen:).
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

  override func cancelOperation(_ sender: Any?) {
    close()
  }

  override func close() {
    super.close()
  }
}

// MARK: - TranslateWindowController  (mirrors Bob.TranslateWindowController)

final class TranslateWindowController: NSWindowController, NSWindowDelegate {
  static let shared = TranslateWindowController()

  private var contentView: TranslateContentView?
  private var autoHideTimer: Timer?

  private override init(window: NSWindow?) {
    super.init(window: window)
  }

  required init?(coder: NSCoder) { fatalError() }

  override func windowDidLoad() {
    super.windowDidLoad()
  }

  func show(payload: TranslationPayload) {
    NSLog("[LumenWindow] show() enter isMain=\(Thread.isMainThread)")
    if self.window == nil {
      NSLog("[LumenWindow] creating window")
      // Fixed width 400 (matches Bob). Height is computed below from content
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
      self.window = w
    }
    guard let w = self.window, let cv = self.contentView else {
      NSLog("[LumenWindow] no window or contentView!")
      return
    }
    cv.update(payload: payload)

    // Activate the app first, then show.
    NSApp.activate(ignoringOtherApps: true)

    // Width is fixed at 400 (matches Bob). Height grows with content; the
    // internal text views become scrollable only when text exceeds the
    // available screen height. No artificial max height cap — Bob grows
    // to ~530+ for long text and we mirror that.
    let width = 400
    cv.setTextContainerWidth(CGFloat(width - 32))
    let srcH = cv.sourceTextHeight
    let trH = cv.translationTextHeight
    // Cap each text view's height to fit within the screen, scrolling inside.
    let screenH = NSScreen.main?.visibleFrame.height ?? 800
    let maxSrc = min(srcH, screenH * 0.35)
    let maxTr = min(trH, screenH * 0.45)
    cv.setScrollHeights(source: maxSrc, translation: maxTr)
    // Layout: 16 top + src + 12 + 1 (divider) + 12 + tr + 14 + 24 (button row) + 16 bottom
    let height = max(240, 16 + maxSrc + 12 + 1 + 12 + maxTr + 14 + 24 + 16)
    NSLog("[LumenWindow] height src=\(srcH) tr=\(trH) final=\(height)")

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

    showWindow(self)
    w.makeKeyAndOrderFront(nil)
    NSLog("[LumenWindow] window after show frame=\(w.frame) isVisible=\(w.isVisible)")

    autoHideTimer?.invalidate()
    autoHideTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] _ in
      self?.window?.orderOut(nil)
    }
  }

  // Hide when we lose focus (mirrors Bob's windowDidResignKey:).
  func windowDidResignKey(_ notification: Notification) {
    // Don't auto-close on resignKey; PopClip is invoked while user is still
    // in the source app. Keep the 20s auto-hide timer instead.
  }
}


// MARK: - Content view (AppKit, mirrors Bob: fixed width, scrollable text)

final class TranslateContentView: NSView {
  private let sourceScrollView = NSScrollView()
  private let translationScrollView = NSScrollView()
  private let sourceTextView = TranslateContentView.makeTextView()
  private let translationTextView = TranslateContentView.makeTextView()
  private let engineLabel = NSTextField(labelWithString: "")
  private let copyButton = NSButton()
  private let speakButton = NSButton()
  private let closeButton = NSButton()
  private let divider = NSBox()
  private var currentTranslation = ""
  // Guards against recursive scroll sync.
  private var syncing = false

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

    divider.boxType = .separator
    divider.translatesAutoresizingMaskIntoConstraints = false

    addSubview(sourceScrollView)
    addSubview(divider)
    addSubview(translationScrollView)
    addSubview(copyButton)
    addSubview(speakButton)
    addSubview(engineLabel)
    addSubview(closeButton)

    let srcC = sourceScrollView.heightAnchor.constraint(equalToConstant: 60)
    let trC = translationScrollView.heightAnchor.constraint(equalToConstant: 120)
    srcC.priority = .required
    trC.priority = .required
    self.sourceHeightC = srcC
    self.translationHeightC = trC

    NSLayoutConstraint.activate([
      sourceScrollView.topAnchor.constraint(equalTo: topAnchor, constant: 28),
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

      engineLabel.centerYAnchor.constraint(equalTo: copyButton.centerYAnchor),
      engineLabel.leadingAnchor.constraint(equalTo: speakButton.trailingAnchor, constant: 8),

      closeButton.topAnchor.constraint(equalTo: topAnchor, constant: 6),
      closeButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
      closeButton.widthAnchor.constraint(equalToConstant: 22),
      closeButton.heightAnchor.constraint(equalToConstant: 22),
    ])
  }

  func update(payload: TranslationPayload) {
    sourceTextView.string = payload.source
    translationTextView.string = payload.translation
    engineLabel.stringValue = payload.engine
    currentTranslation = payload.translation
    needsLayout = true
  }

  @objc private func copyAction() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(currentTranslation, forType: .string)
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
  // Scrolling the translation view does NOT move the source (one-way sync),
  // matching Bob's behaviour.
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

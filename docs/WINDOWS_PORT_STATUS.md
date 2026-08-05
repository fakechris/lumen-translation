# Windows port status

Updated: 2026-08-05

Tracks what the Windows port implements, what it deliberately does not, and
what still has to be verified on real hardware. Written in the same shape as
`lumen-asr/docs/WINDOWS_PORT_STATUS.md` so the two products can be reviewed
side by side.

## Compatibility policy

- macOS remains fully supported. `apps/popclip` and `apps/popclip-window` are
  untouched by this port.
- Windows-specific code is target-gated, with fail-closed stubs so the crate
  still compiles, lints, and tests on a macOS or Linux workstation.
- No macOS behaviour has been changed. The single shared-code change is an
  additive export from `@lumen/engines` (`PROVIDER_CATALOG_SOURCE`), so hosts
  with different UI policy can build their own view of the catalog instead of
  vendoring a second copy.

## What "porting" means here

The browser extension, userscript, mobile shell, worker, and every package
under `packages/` are already platform-neutral TypeScript. The port is
therefore about the *desktop* product, which on macOS is two pieces:

| Piece | macOS | Windows |
| --- | --- | --- |
| Selection popup | PopClip extension (`apps/popclip`) | Built from scratch — see below |
| Translation window | Swift/AppKit (`apps/popclip-window`) | Tauri v2 (`apps/desktop`) |
| App ↔ popup IPC | AppleScript `translate` / `configure` verbs | Tauri commands and events |
| Preferences storage | `UserDefaults` (plaintext keys) | JSON under `%APPDATA%`, keys encrypted with DPAPI |
| Global hotkey | Carbon `RegisterEventHotKey` | `tauri-plugin-global-shortcut` |
| Menu bar | `NSStatusItem` | Tray icon and menu |
| Speak | `NSSpeechSynthesizer` | Web Speech API in WebView2 |
| App icon | `.icns` via `swiftc` + `iconutil` | `.ico` via `tools/gen-windows-icons.mjs` |

## Implemented

### The PopClip replacement

- `WH_MOUSE_LL` and `WH_KEYBOARD_LL` hooks on a dedicated thread with its own
  message loop. The callbacks only classify the event and push it down a
  channel: Windows silently evicts a hook whose callback overruns
  `LowLevelHooksTimeout` (300 ms by default).
- UI Automation `TextPattern` reads the selection without touching the
  clipboard or synthesising input. This is always tried first, and asking for
  the pattern is also what wakes Chromium's accessibility tree up.
- Synthesised Ctrl+C is the fallback, and restores the previous clipboard text.
  It is opt-out in Preferences → Selection.
- A plain click never raises a speculative action bar — only a drag past a
  6 px threshold does, and only when the clipboard fallback could actually
  resolve the text. Without that rule every click into any text field pops the
  bar.
- Password fields are never read and never offered.
- The action bar is `WS_EX_NOACTIVATE` + `WS_EX_TOOLWINDOW`, so clicking it
  neither takes focus from the source app nor collapses the selection.
- The bar is dismissed by a click elsewhere, a scroll, or any non-modifier
  keypress.

### Feature parity with the macOS app

- Borderless floating translation window: fixed 400 px width, height grown to
  content, one-way linked scrolling, Copy, Speak, engine label, Esc / Ctrl+W
  and click-outside to hide, re-openable with its previous contents.
- Preferences: provider, per-provider API key and model, endpoint region,
  source/target language, custom OpenAI-compatible endpoint slots, and an
  About tab.
- Tray menu: Translate Selection, Show Last Translation, an Engine submenu
  that mirrors the macOS menu-bar engine switcher, Preferences, Quit.
- The same fallback chain as `LLMService.swift`: selection → Microsoft →
  Google → any configured LLM.
- The same curated provider list, aliases, and legacy-id migration as
  `ProviderCatalog.swift`, driven by the same vendored catalog file.

### Improvements over the macOS app

These are deliberate, and are candidates for back-porting:

- **API keys encrypted at rest** with DPAPI. `UserDefaults` stores them in the
  clear.
- **HTTPS through SChannel** (`native-tls`) rather than a bundled root store,
  so enterprise machines with an inspecting proxy or a private CA work with no
  user action.
- **Streaming translations.** The Swift app blocks on a semaphore for up to
  60 s; here an LLM response renders as it arrives.
- **The provider catalog is parsed once**, in TypeScript, and reused from
  `@lumen/engines`. macOS maintains a second parser in Swift.

## One workspace-wide change this port forced

`package.json` gained a pnpm override:

```json
"pnpm": { "overrides": { "wxt>vite": "^8.1.5" } }
```

`wxt` depends on `vite: ^5.4.19 || ^6.3.4 || ^7.0.0 || ^8.0.0-0`, so which vite
it actually gets is decided by whatever else is in the workspace. `apps/mobile`
already asked for vite ^6; `apps/desktop` made that two, which was enough for
pnpm to settle wxt on 6 as well. `wxt.config.ts`'s types then came from vite 6
while `@tailwindcss/vite` stayed on 8, and `pnpm --filter @lumen/extension
typecheck` stopped compiling.

The override pins it, so the extension's toolchain no longer depends on how
many other apps happen to use vite 6 — it was one `pnpm install` away from
breaking on its own.

For the same reason `apps/desktop` deliberately does **not** depend on
`@vitejs/plugin-react`: a second requester of `^4` is enough for pnpm to dedupe
`@wxt-dev/module-react`'s `@vitejs/plugin-react@^6` down to 4, which is typed
against vite 5/6 and fails against the extension's vite 8. Vite's own esbuild
transform already provides the automatic JSX runtime; only React Fast Refresh
is lost.

## Deliberate limitations

- **Keyboard selections do not raise the action bar.** Shift+arrows and Ctrl+A
  are served by the `Alt+Ctrl+T` hotkey instead. There is no reliable way to
  place a popup at the caret across every Windows text stack, and a bar in the
  wrong place is worse than no bar.
- **The clipboard fallback preserves text only.** If the clipboard held an
  image, a file list, or rich text, that content is lost. Users who can't
  accept that can turn the fallback off, at the cost of the bar not appearing
  in apps with no accessible text.
- **x64 only.** An arm64 build is a bundle-target change, not a code change,
  but it is not part of this milestone.
- **Both artefacts are unsigned.** SmartScreen warnings are expected on the
  NSIS installer. The Store signs the MSIX after certification; direct
  sideloading still needs a trusted signature.
- **Store review risk.** The MSIX declares nothing beyond `runFullTrust`, but
  a global keyboard hook is the kind of thing Store review asks about. The
  NSIS installer is the primary distribution channel.

## Verification

Done on a macOS workstation:

- `cargo test` — 14 passing (settings round-trip and DPAPI-marker checks,
  window clamping, selection-classification policy).
- `cargo clippy --all-targets` — clean.
- `cargo fmt --all --check` — clean.
- `cargo check` and `cargo clippy` for `x86_64-pc-windows-msvc` over the
  Windows-only modules (hooks, UI Automation, DPAPI, clipboard, window
  helpers), which is the code a non-Windows host would otherwise never
  compile. The Tauri glue could not be cross-checked because `tauri-build`
  runs a Windows resource compiler that is not available off-Windows.
- `pnpm --filter @lumen/desktop typecheck` — clean.
- `pnpm --filter @lumen/desktop test` — 47 passing (catalog, settings,
  fallback chain).
- `pnpm --filter @lumen/desktop build` — clean.

### Pending on a Windows machine

Nothing below has run on real hardware yet. `ci-windows.yml` covers items 1–4
automatically; the rest need a person.

1. `cargo clippy --all-targets -- -D warnings` in `apps/desktop/src-tauri`
   (first real compile of the Tauri glue and the tray/hotkey code).
2. `cargo test` in `apps/desktop/src-tauri` — the DPAPI and Win32 clipboard
   tests only execute here.
3. `pnpm --filter @lumen/desktop tauri build --bundles nsis`.
4. `scripts/windows/build-msix.ps1` passes MakeAppx validation.
5. Install from the NSIS installer and confirm the app starts to the tray.
6. Action bar behaviour by app family: Notepad and RichEdit (Win32), Settings
   and Mail (WinUI/UWP), Chrome and Edge (Chromium), VS Code and Slack
   (Electron), Word and Outlook (Office), Firefox (its own a11y stack), and a
   PDF viewer.
7. Confirm the bar never appears over a password field, in Windows Hello
   prompts, or on the UAC secure desktop.
8. Confirm the clipboard is restored after a fallback copy, and that clipboard
   history (Win+V) does not fill with Lumen entries.
9. Multi-monitor and mixed-DPI placement: bar and translation window must land
   on the monitor the selection was made on, at the right scale.
10. Confirm the hooks survive a session lock/unlock and a display topology
    change, and that Windows has not evicted them after prolonged use.
11. Confirm `Alt+Ctrl+T` and `Alt+Ctrl+L` register, and that a conflict with
    another app degrades to a warning rather than a crash.
12. Launch-at-login toggles the registry Run entry and the app starts hidden.
13. Second-launch behaviour: the single-instance plugin surfaces Preferences
    instead of installing a second set of hooks.

Record failures here as they are found.

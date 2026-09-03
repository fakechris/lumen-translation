//! Lumen Translation for Windows.
//!
//! macOS ships a Swift menu-bar app driven by PopClip. Windows has no PopClip,
//! so this app plays both roles: it watches for text selections itself (see
//! [`platform::selection`]) and owns the translation window that PopClip used
//! to summon over AppleScript.
//!
//! Division of labour with the frontend:
//!
//! * **Rust** owns everything Windows-shaped — hooks, UI Automation, the
//!   clipboard, window placement, the tray, global shortcuts, and the settings
//!   file (API keys encrypted with DPAPI).
//! * **TypeScript** owns the provider catalog and the translation itself,
//!   reusing `@lumen/engines` so the desktop app, the browser extension and the
//!   userscript can't drift apart.
//!
//! That split is why the tray's Engine submenu is populated by the frontend
//! calling [`set_engine_list`] rather than by Rust parsing the catalog.

mod platform;
mod settings;
mod tray;

#[cfg(target_os = "macos")]
mod caption;

use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use tauri::tray::{TrayIconBuilder, TrayIconId};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use platform::selection::SelectionEvent;
use platform::{selection, window_ext, Point, Rect, SelectionConfig};
#[cfg(target_os = "macos")]
use settings::LiveSubtitleCaptureMode;
use settings::Settings;
use tray::Engine;

const WINDOW_TRANSLATE: &str = "translate";
const WINDOW_PREFS: &str = "prefs";
const WINDOW_BAR: &str = "bar";
#[cfg(target_os = "macos")]
const WINDOW_CAPTION: &str = "caption";
const TRAY_ID: &str = "main";

/// Action bar size in logical pixels. Fixed rather than measured: the bar has
/// exactly one button, and a round trip to the webview to learn its size would
/// cost more than the gesture's whole latency budget.
const BAR_SIZE: (f64, f64) = (96.0, 36.0);
/// Gap between the cursor and the bar, in logical pixels.
const BAR_CURSOR_GAP: f64 = 14.0;

#[cfg(target_os = "macos")]
const CAPTION_HEIGHT: f64 = 240.0;
#[cfg(target_os = "macos")]
const CAPTION_EXPANDED_HEIGHT: f64 = 440.0;
#[cfg(target_os = "macos")]
const CAPTION_WIDTH_RATIO: f64 = 0.72;
#[cfg(target_os = "macos")]
const CAPTION_MIN_WIDTH: f64 = 720.0;
#[cfg(target_os = "macos")]
const CAPTION_MAX_WIDTH: f64 = 1200.0;
/// Margin from the bottom of the screen (above the Dock).
#[cfg(target_os = "macos")]
const CAPTION_BOTTOM_OFFSET: f64 = 64.0;
#[cfg(target_os = "macos")]
const CAPTION_ERROR_VISIBLE_FOR: Duration = Duration::from_secs(4);

pub struct AppState {
    pub settings: RwLock<Settings>,
    settings_path: PathBuf,
    /// Providers as the frontend sees them, for the tray's Engine submenu.
    pub engines: RwLock<Vec<Engine>>,
    /// Text UI Automation captured when the bar was raised, if any. Consumed
    /// by `translate_selection` so the common path never touches the clipboard.
    pending_selection: Mutex<Option<String>>,
    /// Translation requests are pulled by the webview after its listener is
    /// installed. Tauri events are not buffered, so the event alone can lose
    /// the first request while React is still mounting.
    pending_translation: Mutex<Option<String>>,
    /// Live-subtitle spike session (macOS only; empty state elsewhere).
    #[cfg(target_os = "macos")]
    pub caption: caption::CaptionSession,
    /// Recoverable caption output delivery for hidden/suspended WebViews.
    #[cfg(target_os = "macos")]
    caption_journal: RwLock<caption::CaptionEventJournal>,
    /// Latest target or transient startup error, pulled after the caption
    /// webview has installed its event listeners. Revisions make delayed
    /// error dismissal safe when another caption session starts meanwhile.
    #[cfg(target_os = "macos")]
    caption_status: RwLock<CaptionWindowState>,
}

impl AppState {
    fn selection_config(&self) -> SelectionConfig {
        let s = self.settings.read();
        SelectionConfig {
            enabled: s.selection_popup_enabled,
            clipboard_fallback: s.selection_clipboard_fallback,
            min_chars: s.min_selection_chars,
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Settings {
    state.settings.read().clone()
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    window: tauri::Window,
    state: tauri::State<'_, AppState>,
    settings: Settings,
) -> Result<(), String> {
    apply_settings(&app, &state, settings, Some(window.label().to_string()))
}

/// Persist `settings`, react to whatever changed, and tell the other windows.
///
/// `origin` is the label of the window that made the change, if any. It is
/// excluded from the broadcast: Preferences writes through on every keystroke,
/// so echoing the settings back would drive its controlled inputs from a
/// round trip and drop characters typed while one was in flight.
fn apply_settings(
    app: &AppHandle,
    state: &AppState,
    settings: Settings,
    origin: Option<String>,
) -> Result<(), String> {
    apply_settings_with(app, state, origin, |_| settings)
}

/// Apply one settings transformation while holding the single write guard
/// across compare, durable save, and in-memory replacement.
fn apply_settings_with<F>(
    app: &AppHandle,
    state: &AppState,
    origin: Option<String>,
    update: F,
) -> Result<(), String>
where
    F: FnOnce(&Settings) -> Settings,
{
    let (previous, settings) = {
        let mut guard = state.settings.write();
        let previous = guard.clone();
        let settings = update(&previous);
        if previous == settings {
            return Ok(());
        }
        settings::save(&state.settings_path, &settings).map_err(|e| e.to_string())?;
        *guard = settings.clone();
        (previous, settings)
    };

    if previous.hotkey_show_last != settings.hotkey_show_last
        || previous.hotkey_translate_selection != settings.hotkey_translate_selection
        || previous.hotkey_translate_clipboard != settings.hotkey_translate_clipboard
    {
        register_shortcuts(app, &previous, &settings);
    }
    if previous.launch_at_login != settings.launch_at_login {
        apply_autostart(app, settings.launch_at_login);
    }
    #[cfg(target_os = "macos")]
    if previous.show_dock_icon != settings.show_dock_icon {
        apply_dock_icon(app, settings.show_dock_icon);
    }
    // Only the engine list, active provider, autostart, and dock toggle show up in the tray.
    if previous.provider_id != settings.provider_id
        || previous.custom_providers != settings.custom_providers
        || previous.hotkey_show_last != settings.hotkey_show_last
        || previous.hotkey_translate_selection != settings.hotkey_translate_selection
        || previous.hotkey_translate_clipboard != settings.hotkey_translate_clipboard
        || previous.launch_at_login != settings.launch_at_login
        || previous.show_dock_icon != settings.show_dock_icon
    {
        tray::refresh(app, &TrayIconId::new(TRAY_ID));
    }

    let _ = app.emit_filter("settings-changed", &settings, |target| match target {
        tauri::EventTarget::WebviewWindow { label } => Some(label) != origin.as_ref(),
        _ => false,
    });
    Ok(())
}

/// Push the frontend's provider list over so the tray can offer it.
#[tauri::command]
fn set_engine_list(app: AppHandle, state: tauri::State<'_, AppState>, engines: Vec<Engine>) {
    *state.engines.write() = engines;
    tray::refresh(&app, &TrayIconId::new(TRAY_ID));
}

/// Size and place the translation window for the content it now holds.
///
/// Placement lives in Rust because Tauri's `Monitor` reports full display
/// bounds; using them would put the window under the taskbar. Mirrors the
/// macOS placement: horizontally centred, in the upper third of the work area.
#[tauri::command]
fn place_translate_window(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let Some(window) = app.get_webview_window(WINDOW_TRANSLATE) else {
        return Ok(());
    };
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let area = window_ext::work_area_at(window_ext::cursor_position());

    let physical_w = (width * scale).round() as i32;
    // Never taller than the work area, whatever the content measures.
    let physical_h = ((height * scale).round() as i32).min(area.height() - 40);

    let origin = area.clamp(
        Point {
            x: area.left + (area.width() - physical_w) / 2,
            y: area.top + (area.height() as f64 * 0.18) as i32,
        },
        physical_w,
        physical_h,
    );

    window
        .set_size(PhysicalSize::new(physical_w as u32, physical_h as u32))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(origin.x, origin.y))
        .map_err(|e| e.to_string())
}

/// Resolve the current selection and translate it. Invoked by the action bar,
/// the tray, and the global shortcut.
#[tauri::command]
async fn translate_selection(app: AppHandle) -> Result<(), String> {
    hide_bar(&app);
    let state = app.state::<AppState>();
    let cached = state.pending_selection.lock().take();

    let text = match cached {
        Some(text) => Some(text),
        // Blocking: UI Automation is synchronous COM, and the clipboard
        // fallback waits for the focused app to service Ctrl+C.
        None => tauri::async_runtime::spawn_blocking(selection::resolve_selection)
            .await
            .map_err(|e| e.to_string())?,
    };

    match text {
        Some(text) if !text.trim().is_empty() => show_translation(&app, text.trim()),
        _ => {
            log::info!("nothing selected to translate");
            Ok(())
        }
    }
}

/// Read text directly from the clipboard and translate it in the floating window.
#[tauri::command]
async fn translate_clipboard(app: AppHandle) -> Result<(), String> {
    hide_bar(&app);
    let text = tauri::async_runtime::spawn_blocking(platform::clipboard::read_text)
        .await
        .map_err(|e| e.to_string())?;

    match text {
        Some(text) if !text.trim().is_empty() => show_translation(&app, text.trim()),
        _ => {
            log::info!("no text found in clipboard to translate");
            Ok(())
        }
    }
}

/// Re-show the translation window with whatever it last displayed.
#[tauri::command]
fn show_last(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(WINDOW_TRANSLATE) else {
        return Ok(());
    };
    // The window is hidden, never destroyed, so its React state still holds
    // the previous translation — showing it is all that's needed.
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
fn open_preferences(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(WINDOW_PREFS) else {
        return Ok(());
    };
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

/// Pull the latest translation request after the frontend has installed its
/// event listener. Taking it makes a mount/event race deliver exactly once.
#[tauri::command]
fn take_pending_translation(state: tauri::State<'_, AppState>) -> Option<String> {
    state.pending_translation.lock().take()
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

fn show_translation(app: &AppHandle, text: &str) -> Result<(), String> {
    let Some(window) = app.get_webview_window(WINDOW_TRANSLATE) else {
        return Ok(());
    };
    *app.state::<AppState>().pending_translation.lock() = Some(text.to_string());
    app.emit_to(
        WINDOW_TRANSLATE,
        "translate-text",
        serde_json::json!({ "text": text }),
    )
    .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

fn hide_bar(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_BAR) {
        let _ = window.hide();
    }
    selection::set_bar_rect(None);
}

/// Show the action bar just above the cursor, nudged fully on-screen.
fn show_bar(app: &AppHandle, at: Point) {
    let Some(window) = app.get_webview_window(WINDOW_BAR) else {
        return;
    };
    let Ok(scale) = window.scale_factor() else {
        return;
    };
    let width = (BAR_SIZE.0 * scale).round() as i32;
    let height = (BAR_SIZE.1 * scale).round() as i32;
    let gap = (BAR_CURSOR_GAP * scale).round() as i32;

    let area = window_ext::work_area_at(at);
    // Above the cursor by preference — the pointer is usually at the *end* of
    // a left-to-right selection, so below would cover the next line of text.
    let origin = area.clamp(
        Point {
            x: at.x - width / 2,
            y: at.y - height - gap,
        },
        width,
        height,
    );

    if window
        .set_position(PhysicalPosition::new(origin.x, origin.y))
        .is_err()
    {
        return;
    }
    // Tell the hook thread where we are, so the click that activates the bar
    // isn't also read as a click-elsewhere that dismisses it.
    selection::set_bar_rect(Some(Rect {
        left: origin.x,
        top: origin.y,
        right: origin.x + width,
        bottom: origin.y + height,
    }));
    let _ = window.show();
}

/// Apply `WS_EX_NOACTIVATE` once the window exists.
fn make_bar_non_activating(window: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    match window.hwnd() {
        Ok(hwnd) => window_ext::make_non_activating(hwnd.0 as isize),
        Err(err) => log::error!("could not read the action bar's window handle: {err}"),
    }
    #[cfg(not(target_os = "windows"))]
    let _ = window;
}

// ---------------------------------------------------------------------------
// Shortcuts and autostart
// ---------------------------------------------------------------------------

fn register_shortcuts(app: &AppHandle, previous: &Settings, next: &Settings) {
    let manager = app.global_shortcut();
    for accelerator in [
        &previous.hotkey_show_last,
        &previous.hotkey_translate_selection,
        &previous.hotkey_translate_clipboard,
    ] {
        if let Ok(shortcut) = accelerator.parse::<Shortcut>() {
            let _ = manager.unregister(shortcut);
        }
    }
    for accelerator in [
        &next.hotkey_show_last,
        &next.hotkey_translate_selection,
        &next.hotkey_translate_clipboard,
    ] {
        match accelerator.parse::<Shortcut>() {
            Ok(shortcut) => {
                if let Err(err) = manager.register(shortcut) {
                    // Another app already owns the combination. Not fatal —
                    // the tray and the action bar still work.
                    log::warn!("could not register {accelerator}: {err}");
                }
            }
            Err(err) => log::warn!("{accelerator} is not a valid accelerator: {err}"),
        }
    }
}

fn apply_autostart(app: &AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    if let Err(err) = result {
        log::error!("could not update the launch-at-login setting: {err}");
    }
}

#[cfg(target_os = "macos")]
fn apply_dock_icon(app: &AppHandle, show: bool) {
    let policy = if show {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };
    if let Err(err) = app.set_activation_policy(policy) {
        log::warn!("could not set activation policy: {err}");
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Whether this host can tap per-app system audio (macOS 14.2+ Core Audio
/// process taps). Gates the live-subtitle feature; reported so the frontend
/// can hide the entry point on incapable hosts instead of failing at runtime.
#[tauri::command]
fn live_subtitle_support() -> bool {
    #[cfg(target_os = "macos")]
    {
        lumen_platform_macos::system_audio_capability_available()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Start the live-subtitle spike: tap the frontmost app's audio and stream
/// recognition results to the caption overlay window.
// Not cfg-gated at the fn level: generate_handler! references the command on
// every platform, and a gated fn would not compile into the macro's expansion
// on Windows. The non-mac body is the graceful refusal instead.
#[tauri::command]
async fn live_subtitle_start(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // Failures surface in the overlay instead of dying in stderr: open
        // the window and emit the message so the user sees why nothing plays.
        if let Err(err) = live_subtitle_start_mac(app.clone()).await {
            log::error!("live subtitle start failed: {err}");
            app.state::<AppState>()
                .caption_journal
                .write()
                .end_session();
            let status = CaptionWindowStatus::Error(user_facing_caption_start_error(&err));
            let revision = app
                .state::<AppState>()
                .caption_status
                .write()
                .publish(status.clone());
            show_caption_window(&app, status);
            schedule_caption_error_dismiss(app.clone(), revision);
            tray::refresh(&app, &TrayIconId::new(TRAY_ID));
            return Err(err);
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("live subtitles require macOS (system-audio process taps)".into())
    }
}

#[cfg(target_os = "macos")]
async fn live_subtitle_start_mac(app: AppHandle) -> Result<(), String> {
    let capture_mode = app
        .state::<AppState>()
        .settings
        .read()
        .live_subtitle_capture_mode;
    // Only the privacy-scoped mode consults focus. The global mode creates a
    // tap immediately and receives audio from any app that starts later.
    let frontmost = if capture_mode == LiveSubtitleCaptureMode::FrontmostApp {
        let frontmost_app = lumen_platform_macos::frontmost_app_basic().ok_or(
            "no frontmost app to tap — switch to the video (browser/player) first, then start",
        )?;
        Some((
            frontmost_app
                .bundle_id
                .ok_or("frontmost app has no bundle id; cannot target it for an audio tap")?,
            frontmost_app.app_name,
        ))
    } else {
        None
    };
    let plan = caption_capture_plan(capture_mode, frontmost)?;
    let app_name = plan.app_name;
    let recognizer = tauri::async_runtime::spawn_blocking(caption::load_streaming_recognizer)
        .await
        .map_err(|error| format!("streaming model loader failed: {error}"))??;
    let state = app.state::<AppState>();

    // Finish any prior worker before opening a new journal session. Otherwise
    // its trailing flush could publish an old final into the new session.
    state.caption.stop();
    let session_id = state.caption_journal.write().begin_session();

    // The caption WebView is pre-created at app launch, so publish the target
    // and reveal the listening state before model/capture startup. This keeps
    // the first partial/final from racing a WebView that does not exist yet.
    let status = CaptionWindowStatus::Target(app_name.clone());
    state.caption_status.write().publish(status.clone());
    show_caption_window(&app, status);
    let _ = app.emit(
        "caption-session-reset",
        CaptionSessionResetEvent {
            session_id,
            app_name: app_name.clone(),
        },
    );
    state.caption.start(
        app.clone(),
        session_id,
        plan.target,
        app_name.clone(),
        recognizer,
    )?;
    let _ = app.emit("caption-started", &app_name);
    tray::refresh(&app, &TrayIconId::new(TRAY_ID));
    Ok(())
}

#[cfg(target_os = "macos")]
struct CaptionCapturePlan {
    target: lumen_platform_macos::SystemAudioTarget,
    app_name: String,
}

#[cfg(target_os = "macos")]
fn caption_capture_plan(
    mode: LiveSubtitleCaptureMode,
    frontmost: Option<(String, String)>,
) -> Result<CaptionCapturePlan, String> {
    match mode {
        LiveSubtitleCaptureMode::AllSystemAudio => Ok(CaptionCapturePlan {
            target: lumen_platform_macos::SystemAudioTarget::all_system_audio(),
            app_name: "系统音频".into(),
        }),
        LiveSubtitleCaptureMode::FrontmostApp => {
            let (bundle_id, app_name) = frontmost.ok_or(
                "no frontmost app to tap — switch to the video (browser/player) first, then start",
            )?;
            // Never tap ourselves: the caption overlay would transcribe its own UI.
            if bundle_id.to_ascii_lowercase().contains("lumen") {
                return Err("frontmost app is Lumen itself; switch to the video first".into());
            }
            let app_name = if app_name.is_empty() {
                bundle_id.clone()
            } else {
                app_name
            };
            Ok(CaptionCapturePlan {
                target: lumen_platform_macos::SystemAudioTarget::new([bundle_id]),
                app_name,
            })
        }
    }
}

/// Stop the live-subtitle spike and hide the overlay.
#[tauri::command]
fn live_subtitle_stop(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let state = app.state::<AppState>();
        state.caption.stop();
        state.caption_journal.write().end_session();
        state.caption_status.write().clear();
        if let Some(window) = app.get_webview_window(WINDOW_CAPTION) {
            let _ = window.hide();
        }
        let _ = app.emit("caption-stopped", ());
        tray::refresh(&app, &TrayIconId::new(TRAY_ID));
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

/// Dynamically toggle mouse click-through for the live caption window.
#[tauri::command]
fn set_caption_clickthrough(app: AppHandle, clickthrough: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(window) = app.get_webview_window(WINDOW_CAPTION) {
            window.set_ignore_cursor_events(clickthrough).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, clickthrough);
        Ok(())
    }
}

/// Dynamically expand or collapse the caption window height while keeping
/// the bottom position anchored.
#[tauri::command]
fn set_caption_expanded(app: AppHandle, expanded: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(window) = app.get_webview_window(WINDOW_CAPTION) {
            let current_size = window.inner_size().map_err(|e| e.to_string())?;
            let current_pos = window.inner_position().map_err(|e| e.to_string())?;
            let scale = window.scale_factor().map_err(|e| e.to_string())?;
            let compact_h = (CAPTION_HEIGHT * scale).round() as u32;
            let expanded_h = (CAPTION_EXPANDED_HEIGHT * scale).round() as u32;
            let target_h = if expanded { expanded_h } else { compact_h };
            let diff = target_h as i32 - current_size.height as i32;
            let target_y = current_pos.y - diff;
            let _ = window.set_size(tauri::PhysicalSize::new(current_size.width, target_h));
            let _ = window.set_position(tauri::PhysicalPosition::new(current_pos.x, target_y));
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, expanded);
        Ok(())
    }
}

/// Live-subtitle running state, for the tray check item and frontend.
#[tauri::command]
fn live_subtitle_running(app: AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        app.state::<AppState>().caption.is_running()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        false
    }
}

/// The always-on-top caption overlay state shared with its pre-created WebView.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
enum CaptionWindowStatus {
    Target(String),
    Error(String),
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptionSessionResetEvent {
    session_id: u64,
    app_name: String,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
struct CaptionWindowState {
    revision: u64,
    current: Option<CaptionWindowStatus>,
}

#[cfg(target_os = "macos")]
impl CaptionWindowState {
    fn publish(&mut self, status: CaptionWindowStatus) -> u64 {
        self.revision = self.revision.wrapping_add(1).max(1);
        self.current = Some(status);
        self.revision
    }

    fn clear(&mut self) {
        self.revision = self.revision.wrapping_add(1).max(1);
        self.current = None;
    }

    fn dismiss_error(&mut self, revision: u64) -> bool {
        if self.revision != revision || !matches!(self.current, Some(CaptionWindowStatus::Error(_)))
        {
            return false;
        }
        self.clear();
        true
    }

    fn current(&self) -> Option<CaptionWindowStatus> {
        self.current.clone()
    }
}

#[cfg(target_os = "macos")]
fn user_facing_caption_start_error(error: &str) -> String {
    if error.contains("target app is not producing audio") {
        "当前应用没有播放声音。请先在视频或会议应用中开始播放，再启动实时字幕。".into()
    } else if error.contains("frontmost app is Lumen itself") {
        "请先切换到正在播放声音的视频或会议应用，再启动实时字幕。".into()
    } else {
        "实时字幕启动失败，请切换到正在播放声音的应用后重试。".into()
    }
}

#[cfg(target_os = "macos")]
fn schedule_caption_error_dismiss(app: AppHandle, revision: u64) {
    let _ = std::thread::Builder::new()
        .name("lumen-caption-error-dismiss".into())
        .spawn(move || {
            std::thread::sleep(CAPTION_ERROR_VISIBLE_FOR);
            let should_hide = app
                .state::<AppState>()
                .caption_status
                .write()
                .dismiss_error(revision);
            if should_hide {
                if let Some(window) = app.get_webview_window(WINDOW_CAPTION) {
                    let _ = window.hide();
                }
            }
        });
}

/// Latest live-subtitle startup state. The caption webview pulls this only
/// after its event listeners are installed, closing the first-window race.
#[cfg(target_os = "macos")]
#[tauri::command]
fn live_subtitle_status(app: AppHandle) -> Option<CaptionWindowStatus> {
    app.state::<AppState>().caption_status.read().current()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn live_subtitle_status(app: AppHandle) -> Option<serde_json::Value> {
    let _ = app;
    None
}

/// Incremental recovery path for caption events missed while the WebView was
/// hidden, suspended, mounting listeners, or reloading.
#[cfg(target_os = "macos")]
#[tauri::command]
fn live_subtitle_events(
    app: AppHandle,
    session_id: Option<u64>,
    after_event_id: u64,
) -> caption::CaptionJournalSnapshot {
    app.state::<AppState>()
        .caption_journal
        .read()
        .snapshot_since(session_id, after_event_id)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn live_subtitle_events(
    app: AppHandle,
    session_id: Option<u64>,
    after_event_id: u64,
) -> serde_json::Value {
    let _ = (app, session_id, after_event_id);
    serde_json::json!({ "sessionId": 0, "entries": [] })
}

#[cfg(target_os = "macos")]
fn emit_caption_window_status(window: &WebviewWindow, status: &CaptionWindowStatus) {
    match status {
        CaptionWindowStatus::Target(app_name) => {
            let _ = window.emit("caption-target", app_name);
        }
        CaptionWindowStatus::Error(error) => {
            let _ = window.emit("caption-error", error);
        }
    }
}

#[cfg(target_os = "macos")]
fn show_caption_window(app: &AppHandle, status: CaptionWindowStatus) {
    let window = match app.get_webview_window(WINDOW_CAPTION) {
        Some(w) => w,
        None => match build_caption_window(app) {
            Ok(w) => w,
            Err(err) => {
                log::error!("caption window build failed: {err}");
                return;
            }
        },
    };
    position_caption_window(app, &window);
    emit_caption_window_status(&window, &status);
    let _ = window.show();
}

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq)]
struct CaptionWindowGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[cfg(target_os = "macos")]
fn caption_window_geometry(
    monitor_x: i32,
    monitor_y: i32,
    monitor_width: u32,
    monitor_height: u32,
    scale: f64,
) -> CaptionWindowGeometry {
    let logical_width = monitor_width as f64 / scale;
    let logical_height = monitor_height as f64 / scale;
    let width = (logical_width * CAPTION_WIDTH_RATIO).clamp(
        CAPTION_MIN_WIDTH.min(logical_width),
        CAPTION_MAX_WIDTH.min(logical_width),
    );
    let height = CAPTION_HEIGHT.min((logical_height - CAPTION_BOTTOM_OFFSET).max(88.0));
    let physical_width = (width * scale).round() as u32;
    let physical_height = (height * scale).round() as u32;
    let physical_bottom_offset = (CAPTION_BOTTOM_OFFSET * scale).round() as u32;

    CaptionWindowGeometry {
        x: monitor_x + ((monitor_width.saturating_sub(physical_width)) / 2) as i32,
        y: monitor_y
            + (monitor_height.saturating_sub(physical_height + physical_bottom_offset)) as i32,
        width: physical_width,
        height: physical_height,
    }
}

#[cfg(target_os = "macos")]
fn position_caption_window(app: &AppHandle, window: &WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|position| {
            app.monitor_from_point(position.x, position.y)
                .ok()
                .flatten()
        })
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let position = monitor.position();
    let size = monitor.size();
    let geometry = caption_window_geometry(
        position.x,
        position.y,
        size.width,
        size.height,
        monitor.scale_factor(),
    );

    let _ = window.set_size(PhysicalSize::new(geometry.width, geometry.height));
    let _ = window.set_position(PhysicalPosition::new(geometry.x, geometry.y));
}

#[cfg(target_os = "macos")]
fn configure_caption_window(window: &WebviewWindow) {
    // Keep cursor events active so the overlay controls (close button,
    // settings shortcut, drag handle) are always interactive and responsive.
    let _ = window.set_ignore_cursor_events(false);

    let ns_window_owner = window.clone();
    let _ = window.run_on_main_thread(move || {
        use objc2::msg_send;
        use objc2::runtime::{AnyObject, Bool};

        const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
        const STATIONARY: usize = 1 << 4;
        const IGNORES_CYCLE: usize = 1 << 6;
        const FULL_SCREEN_AUXILIARY: usize = 1 << 8;

        let Ok(pointer) = ns_window_owner.ns_window() else {
            return;
        };
        let ns_window = pointer.cast::<AnyObject>();
        if ns_window.is_null() {
            return;
        }

        unsafe {
            let current: usize = msg_send![ns_window, collectionBehavior];
            let behavior =
                current | CAN_JOIN_ALL_SPACES | STATIONARY | IGNORES_CYCLE | FULL_SCREEN_AUXILIARY;
            let _: () = msg_send![ns_window, setCollectionBehavior: behavior];
            let _: () = msg_send![ns_window, setHidesOnDeactivate: Bool::NO];
            // Use a screen-saver-level overlay so browser full-screen windows
            // cannot cover the captions when focus changes.
            let _: () = msg_send![ns_window, setLevel: 1000_isize];
        }
    });
}

#[cfg(target_os = "macos")]
fn build_caption_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let window =
        WebviewWindowBuilder::new(app, WINDOW_CAPTION, WebviewUrl::App("caption.html".into()))
            .title("Lumen Live Subtitles")
            .inner_size(1024.0, CAPTION_HEIGHT)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(true)
            .focused(false)
            .visible(false)
            .build()?;
    configure_caption_window(&window);
    position_caption_window(app, &window);
    Ok(window)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch surfaces Preferences rather than starting a
            // rival tray icon and a second set of input hooks.
            let _ = open_preferences(app.clone());
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let settings = app.state::<AppState>().settings.read().clone();
                    let matches = |accelerator: &str| {
                        accelerator
                            .parse::<Shortcut>()
                            .is_ok_and(|parsed| &parsed == shortcut)
                    };
                    if matches(&settings.hotkey_translate_selection) {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(err) = translate_selection(app).await {
                                log::error!("translate-selection shortcut failed: {err}");
                            }
                        });
                    } else if matches(&settings.hotkey_translate_clipboard) {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(err) = translate_clipboard(app).await {
                                log::error!("translate-clipboard shortcut failed: {err}");
                            }
                        });
                    } else if matches(&settings.hotkey_show_last) {
                        let _ = show_last(app.clone());
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == WINDOW_CAPTION {
                    api.prevent_close();
                    let _ = live_subtitle_stop(window.app_handle().clone());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            set_engine_list,
            place_translate_window,
            translate_selection,
            translate_clipboard,
            show_last,
            open_preferences,
            take_pending_translation,
            live_subtitle_support,
            live_subtitle_running,
            live_subtitle_events,
            live_subtitle_status,
            live_subtitle_start,
            live_subtitle_stop,
            set_caption_clickthrough,
            set_caption_expanded,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            let settings_path = settings::default_path(app.path().app_config_dir()?);
            #[cfg(target_os = "macos")]
            let settings_file_exists = settings_path.exists();
            #[cfg(target_os = "macos")]
            let mut loaded = settings::load(&settings_path);
            #[cfg(not(target_os = "macos"))]
            let loaded = settings::load(&settings_path);
            #[cfg(target_os = "macos")]
            if !settings_file_exists {
                let imported = settings::overlay_legacy_macos_defaults(&mut loaded);
                if imported > 0 {
                    // Count only; never put preference values or credential
                    // material into logs.
                    log::info!("loaded {imported} legacy macOS preference fields into memory");
                }
            }
            app.manage(AppState {
                settings: RwLock::new(loaded.clone()),
                settings_path,
                engines: RwLock::new(Vec::new()),
                pending_selection: Mutex::new(None),
                pending_translation: Mutex::new(None),
                #[cfg(target_os = "macos")]
                caption: caption::CaptionSession::default(),
                #[cfg(target_os = "macos")]
                caption_journal: RwLock::new(caption::CaptionEventJournal::default()),
                #[cfg(target_os = "macos")]
                caption_status: RwLock::new(CaptionWindowState::default()),
            });

            build_windows(&handle)?;
            build_tray(&handle)?;

            register_shortcuts(&handle, &Settings::default(), &loaded);
            apply_autostart(&handle, loaded.launch_at_login);
            #[cfg(target_os = "macos")]
            apply_dock_icon(&handle, loaded.show_dock_icon);

            // Start the selection watcher. Its config closure reads live
            // settings, so Preferences changes apply without a restart.
            let config_handle = handle.clone();
            let event_handle = handle.clone();
            selection::start(
                move || config_handle.state::<AppState>().selection_config(),
                move |event| match event {
                    SelectionEvent::Show { at, text } => {
                        *event_handle.state::<AppState>().pending_selection.lock() = text;
                        show_bar(&event_handle, at);
                    }
                    SelectionEvent::Dismiss => hide_bar(&event_handle),
                },
            );

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Lumen Translation");
}

#[cfg(all(test, target_os = "macos"))]
mod caption_status_tests {
    use super::{
        caption_capture_plan, caption_window_geometry, CaptionWindowGeometry, CaptionWindowState,
        CaptionWindowStatus,
    };
    use crate::settings::LiveSubtitleCaptureMode;

    #[test]
    fn caption_window_has_ipc_capability() {
        let shared: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/caption.json")).unwrap();
        let windows = capability["windows"].as_array().unwrap();
        let shared_windows = shared["windows"].as_array().unwrap();

        assert!(
            windows.iter().any(|window| window == "caption"),
            "the caption webview must be allowed to listen for captions and invoke status commands"
        );
        assert!(!shared_windows.iter().any(|window| window == "caption"));
    }

    #[test]
    fn caption_window_status_matches_frontend_shape() {
        assert_eq!(
            serde_json::to_value(CaptionWindowStatus::Target("Browser".into())).unwrap(),
            serde_json::json!({ "kind": "target", "message": "Browser" })
        );
        assert_eq!(
            serde_json::to_value(CaptionWindowStatus::Error("tap failed".into())).unwrap(),
            serde_json::json!({ "kind": "error", "message": "tap failed" })
        );
    }

    #[test]
    fn current_start_error_can_be_dismissed() {
        let mut state = CaptionWindowState::default();
        let revision = state.publish(CaptionWindowStatus::Error("tap failed".into()));

        assert!(state.dismiss_error(revision));
        assert_eq!(state.current(), None);
    }

    #[test]
    fn stale_error_timeout_cannot_hide_a_new_caption_session() {
        let mut state = CaptionWindowState::default();
        let stale_revision = state.publish(CaptionWindowStatus::Error("tap failed".into()));
        state.publish(CaptionWindowStatus::Target("Player".into()));

        assert!(!state.dismiss_error(stale_revision));
        assert_eq!(
            state.current(),
            Some(CaptionWindowStatus::Target("Player".into()))
        );
    }

    #[test]
    fn all_system_audio_does_not_require_a_frontmost_application() {
        let plan = caption_capture_plan(LiveSubtitleCaptureMode::AllSystemAudio, None).unwrap();

        assert!(plan.target.captures_all_system_audio());
        assert_eq!(plan.app_name, "系统音频");
    }

    #[test]
    fn frontmost_mode_validates_and_names_the_selected_application() {
        assert!(caption_capture_plan(LiveSubtitleCaptureMode::FrontmostApp, None).is_err());
        assert!(caption_capture_plan(
            LiveSubtitleCaptureMode::FrontmostApp,
            Some(("app.lumen.translation".into(), "Lumen".into())),
        )
        .is_err());

        let plan = caption_capture_plan(
            LiveSubtitleCaptureMode::FrontmostApp,
            Some(("com.example.player".into(), String::new())),
        )
        .unwrap();
        assert_eq!(plan.app_name, "com.example.player");
    }

    #[test]
    fn caption_window_matches_bottom_center_geometry() {
        assert_eq!(
            caption_window_geometry(0, 0, 3024, 1964, 2.0),
            CaptionWindowGeometry {
                x: 423,
                y: 1356,
                width: 2177,
                height: 480,
            }
        );
    }
}

fn build_windows(app: &AppHandle) -> tauri::Result<()> {
    // All three windows are created up front and hidden. Creating a webview
    // takes ~100 ms, which is far too long to spend after the user has already
    // selected text.
    WebviewWindowBuilder::new(app, WINDOW_TRANSLATE, WebviewUrl::App("index.html".into()))
        .title("Lumen Translation")
        .inner_size(400.0, 280.0)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()?;

    WebviewWindowBuilder::new(app, WINDOW_PREFS, WebviewUrl::App("prefs.html".into()))
        .title("Lumen Translation Settings")
        .inner_size(560.0, 620.0)
        .min_inner_size(480.0, 420.0)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .center()
        .resizable(true)
        .visible(false)
        .build()?;

    let bar = WebviewWindowBuilder::new(app, WINDOW_BAR, WebviewUrl::App("bar.html".into()))
        .title("Lumen")
        .inner_size(BAR_SIZE.0, BAR_SIZE.1)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()?;
    bar.set_size(LogicalSize::new(BAR_SIZE.0, BAR_SIZE.1))?;
    make_bar_non_activating(&bar);

    #[cfg(target_os = "macos")]
    {
        // Mount the caption WebView and its event listeners before a user can
        // start capture. Tauri events are not buffered, so lazy creation loses
        // the first speech burst while React is still loading.
        let _ = build_caption_window(app)?;
    }

    Ok(())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = tray::build_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Lumen Translation")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                tray::ID_TRANSLATE => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(err) = translate_selection(app).await {
                            log::error!("tray translate failed: {err}");
                        }
                    });
                }
                tray::ID_TRANSLATE_CLIPBOARD => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(err) = translate_clipboard(app).await {
                            log::error!("tray translate clipboard failed: {err}");
                        }
                    });
                }
                tray::ID_SHOW_LAST => {
                    let _ = show_last(app.clone());
                }
                tray::ID_PREFERENCES => {
                    let _ = open_preferences(app.clone());
                }
                tray::ID_LAUNCH_AT_LOGIN => {
                    let state = app.state::<AppState>();
                    if let Err(err) = apply_settings_with(app, &state, None, |current| {
                        let mut settings = current.clone();
                        settings.launch_at_login = !settings.launch_at_login;
                        settings
                    }) {
                        log::error!("could not toggle launch at login: {err}");
                    }
                }
                #[cfg(target_os = "macos")]
                tray::ID_SHOW_DOCK_ICON => {
                    let state = app.state::<AppState>();
                    if let Err(err) = apply_settings_with(app, &state, None, |current| {
                        let mut settings = current.clone();
                        settings.show_dock_icon = !settings.show_dock_icon;
                        settings
                    }) {
                        log::error!("could not toggle dock icon: {err}");
                    }
                }
                #[cfg(target_os = "macos")]
                tray::ID_LIVE_CAPTION => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let running = live_subtitle_running(app.clone());
                        let result = if running {
                            live_subtitle_stop(app.clone())
                        } else {
                            live_subtitle_start(app.clone()).await
                        };
                        if let Err(err) = result {
                            log::error!("live subtitle toggle failed: {err}");
                        }
                        if let Some(tray) = app.tray_by_id(TRAY_ID) {
                            tray::refresh(&app, &tray.id());
                        }
                    });
                }
                tray::ID_QUIT => app.exit(0),
                _ => {
                    if let Some(provider_id) = id.strip_prefix(tray::ENGINE_PREFIX) {
                        let state = app.state::<AppState>();
                        // No origin window: every window should hear about a
                        // switch made from the tray.
                        if let Err(err) = apply_settings_with(app, &state, None, |current| {
                            let mut settings = current.clone();
                            settings.provider_id = provider_id.to_string();
                            settings
                        }) {
                            log::error!("could not switch engine: {err}");
                        }
                    }
                }
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

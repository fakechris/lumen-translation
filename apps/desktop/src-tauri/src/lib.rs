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

use std::path::PathBuf;

use parking_lot::{Mutex, RwLock};
use tauri::tray::{TrayIconBuilder, TrayIconId};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use platform::selection::SelectionEvent;
use platform::{selection, window_ext, Point, Rect, SelectionConfig};
use settings::Settings;
use tray::Engine;

const WINDOW_TRANSLATE: &str = "translate";
const WINDOW_PREFS: &str = "prefs";
const WINDOW_BAR: &str = "bar";
const TRAY_ID: &str = "main";

/// Action bar size in logical pixels. Fixed rather than measured: the bar has
/// exactly one button, and a round trip to the webview to learn its size would
/// cost more than the gesture's whole latency budget.
const BAR_SIZE: (f64, f64) = (96.0, 36.0);
/// Gap between the cursor and the bar, in logical pixels.
const BAR_CURSOR_GAP: f64 = 14.0;

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
    {
        register_shortcuts(app, &previous, &settings);
    }
    if previous.launch_at_login != settings.launch_at_login {
        apply_autostart(app, settings.launch_at_login);
    }
    // Only the engine list and the active provider show up in the tray.
    if previous.provider_id != settings.provider_id
        || previous.custom_providers != settings.custom_providers
        || previous.hotkey_show_last != settings.hotkey_show_last
        || previous.hotkey_translate_selection != settings.hotkey_translate_selection
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
    ] {
        if let Ok(shortcut) = accelerator.parse::<Shortcut>() {
            let _ = manager.unregister(shortcut);
        }
    }
    for accelerator in [&next.hotkey_show_last, &next.hotkey_translate_selection] {
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
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
                    } else if matches(&settings.hotkey_show_last) {
                        let _ = show_last(app.clone());
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            set_engine_list,
            place_translate_window,
            translate_selection,
            show_last,
            open_preferences,
            take_pending_translation,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            let settings_path = settings::default_path(app.path().app_config_dir()?);
            let loaded = settings::load(&settings_path);
            app.manage(AppState {
                settings: RwLock::new(loaded.clone()),
                settings_path,
                engines: RwLock::new(Vec::new()),
                pending_selection: Mutex::new(None),
                pending_translation: Mutex::new(None),
            });

            build_windows(&handle)?;
            build_tray(&handle)?;

            register_shortcuts(&handle, &Settings::default(), &loaded);
            apply_autostart(&handle, loaded.launch_at_login);

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
                tray::ID_SHOW_LAST => {
                    let _ = show_last(app.clone());
                }
                tray::ID_PREFERENCES => {
                    let _ = open_preferences(app.clone());
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

//! Tray icon and menu — the Windows counterpart of the macOS `NSStatusItem`.
//!
//! Like the macOS app, this is the only chrome the product has: there is no
//! dock icon, no main window, and no menu bar, so everything the user can do
//! outside a translation lives here.
//!
//! The Engine submenu is rebuilt from the provider list the frontend pushes
//! over (`set_engine_list`). Rust deliberately does not parse the provider
//! catalog itself: it exists once, in TypeScript, and duplicating the curated
//! list here is how the two would drift.

use tauri::menu::{CheckMenuItem, Menu, MenuBuilder, MenuItem, Submenu};
use tauri::tray::TrayIconId;
use tauri::{AppHandle, Manager, Wry};

use crate::AppState;

/// Menu item ids. Engine entries use the `engine:<providerId>` prefix.
pub const ID_TRANSLATE: &str = "translate-selection";
pub const ID_SHOW_LAST: &str = "show-last";
pub const ID_PREFERENCES: &str = "preferences";
pub const ID_QUIT: &str = "quit";
pub const ENGINE_PREFIX: &str = "engine:";

/// A provider as far as the tray is concerned.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Engine {
    pub id: String,
    pub label: String,
}

/// Build the tray menu for the current engine list and selection.
pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let state = app.state::<AppState>();
    let engines = state.engines.read().clone();
    let active = state.settings.read().provider_id.clone();
    let hotkeys = {
        let s = state.settings.read();
        (
            s.hotkey_translate_selection.clone(),
            s.hotkey_show_last.clone(),
        )
    };

    let translate = MenuItem::with_id(
        app,
        ID_TRANSLATE,
        format!("Translate Selection\t{}", hotkeys.0),
        true,
        None::<&str>,
    )?;
    let show_last = MenuItem::with_id(
        app,
        ID_SHOW_LAST,
        format!("Show Last Translation\t{}", hotkeys.1),
        true,
        None::<&str>,
    )?;

    let engine_items: Vec<CheckMenuItem<Wry>> = engines
        .iter()
        .map(|e| {
            CheckMenuItem::with_id(
                app,
                format!("{ENGINE_PREFIX}{}", e.id),
                &e.label,
                true,
                e.id == active,
                None::<&str>,
            )
        })
        .collect::<tauri::Result<_>>()?;
    let engine_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = engine_items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<Wry>)
        .collect();
    let engine_menu = Submenu::with_items(app, "Engine", !engine_refs.is_empty(), &engine_refs)?;

    let preferences = MenuItem::with_id(app, ID_PREFERENCES, "Preferences…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "Quit Lumen Translation", true, None::<&str>)?;

    MenuBuilder::new(app)
        .item(&translate)
        .item(&show_last)
        .separator()
        .item(&engine_menu)
        .separator()
        .item(&preferences)
        .separator()
        .item(&quit)
        .build()
}

/// Re-render the tray menu, e.g. after the engine list or selection changed.
pub fn refresh(app: &AppHandle, tray_id: &TrayIconId) {
    let Some(tray) = app.tray_by_id(tray_id) else {
        return;
    };
    match build_menu(app) {
        Ok(menu) => {
            if let Err(err) = tray.set_menu(Some(menu)) {
                log::error!("could not update the tray menu: {err}");
            }
        }
        Err(err) => log::error!("could not build the tray menu: {err}"),
    }
}

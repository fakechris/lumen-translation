// Windows release builds must not open a console window behind the tray app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    lumen_translation_desktop_lib::run()
}

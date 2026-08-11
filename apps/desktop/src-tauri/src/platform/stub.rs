//! Non-Windows stubs.
//!
//! This app targets Windows, but the crate must still compile, lint and test
//! on a macOS or Linux workstation — that is where most of the development
//! happens, and where `cargo test` runs the platform-neutral logic in
//! [`crate::platform::types`] and [`crate::settings`].
//!
//! Every stub is fail-closed: "no selection", "no secret store", "empty
//! clipboard". Nothing here pretends to work, so a stub that accidentally
//! shipped would degrade visibly rather than silently.

pub mod secret {
    /// No DPAPI outside Windows. The settings layer falls back to storing the
    /// value unencrypted, which is correct for a dev machine and unreachable
    /// in a shipped build.
    pub fn protect(_plain: &[u8]) -> Option<Vec<u8>> {
        None
    }

    pub fn unprotect(_cipher: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

pub mod clipboard {
    pub fn read_text() -> Option<String> {
        None
    }

    pub fn write_text(_text: &str) -> bool {
        false
    }

    pub fn copy_selection() -> Option<String> {
        None
    }
}

pub mod window_ext {
    use crate::platform::{Point, Rect};

    pub fn cursor_position() -> Point {
        Point::default()
    }

    pub fn work_area_at(_p: Point) -> Rect {
        Rect {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        }
    }

    pub fn make_non_activating(_hwnd: isize) {}
}

pub mod selection {
    use crate::platform::{Point, Rect, SelectionConfig};

    #[derive(Debug, Clone)]
    pub enum SelectionEvent {
        Show { at: Point, text: Option<String> },
        Dismiss,
    }

    pub fn set_bar_rect(_rect: Option<Rect>) {}

    pub fn start<C, F>(_config: C, _on_event: F)
    where
        C: Fn() -> SelectionConfig + Send + 'static,
        F: Fn(SelectionEvent) + Send + 'static,
    {
        log::warn!("selection watching is only implemented on Windows");
    }

    pub fn resolve_selection() -> Option<String> {
        None
    }
}

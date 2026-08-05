//! Window and monitor helpers that Tauri does not expose.
//!
//! Two things are needed here that the cross-platform API can't give us:
//! the monitor **work area** (Tauri's `Monitor` reports the full bounds, so a
//! window placed with it can end up under the taskbar), and `WS_EX_NOACTIVATE`
//! on the action bar, without which clicking Lumen would deactivate the app
//! the user just selected text in — and, in most editors, collapse the
//! selection we are about to read.

use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, HMONITOR, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromPoint,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetCursorPos, GetWindowLongPtrW, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SetWindowLongPtrW, SetWindowPos, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

use crate::platform::{Point, Rect};

/// Current mouse position in physical screen pixels.
pub fn cursor_position() -> Point {
    let mut point = POINT::default();
    // SAFETY: `point` is a valid out-parameter for the duration of the call.
    if unsafe { GetCursorPos(&mut point) }.is_err() {
        return Point::default();
    }
    Point {
        x: point.x,
        y: point.y,
    }
}

/// Work area (screen minus taskbar and other appbars) of the monitor
/// containing `p`. Falls back to a 1920x1080 origin-anchored rect if the
/// monitor can't be queried, which is only reachable if the display topology
/// changes mid-call.
pub fn work_area_at(p: Point) -> Rect {
    let point = POINT { x: p.x, y: p.y };
    // SAFETY: MONITOR_DEFAULTTONEAREST guarantees a valid monitor handle even
    // for a point outside every display.
    let monitor: HMONITOR = unsafe { MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    // SAFETY: `cbSize` is set as the API requires and `info` outlives the call.
    let ok = unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool();
    if !ok {
        log::warn!("GetMonitorInfoW failed; falling back to a default work area");
        return Rect {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        };
    }
    let RECT {
        left,
        top,
        right,
        bottom,
    } = info.rcWork;
    Rect {
        left,
        top,
        right,
        bottom,
    }
}

/// Make a window refuse activation and stay out of the taskbar and Alt+Tab.
///
/// Applied to the action bar so that clicking it leaves focus — and therefore
/// the selection — exactly where it was.
pub fn make_non_activating(hwnd: isize) {
    let hwnd = HWND(hwnd as *mut _);
    // SAFETY: `hwnd` comes from Tauri's `Window::hwnd()` and is alive for as
    // long as the window is.
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let wanted = style | (WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize);
        if style != wanted {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, wanted);
        }
        // Re-assert topmost without moving, sizing, or activating: the style
        // change alone does not re-enter the z-order.
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

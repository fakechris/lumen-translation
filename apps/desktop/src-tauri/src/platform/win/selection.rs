//! Selection watching — the half of PopClip that Windows has no equivalent for.
//!
//! Two threads cooperate:
//!
//! * **Hook thread** — owns `WH_MOUSE_LL` + `WH_KEYBOARD_LL` and a message
//!   loop. Low-level hooks run on the installing thread and Windows silently
//!   evicts a hook whose callback overruns `LowLevelHooksTimeout` (300 ms by
//!   default), so the callbacks do nothing but classify the event and push it
//!   down a channel.
//! * **Worker thread** — COM-initialised, does the actual UI Automation and
//!   clipboard work, and calls back into the app.
//!
//! Only *mouse* selections raise the action bar. Keyboard selections
//! (Shift+arrows, Ctrl+A) are served by the global hotkey instead: there is no
//! reliable way to place a popup at the caret across every text stack, and a
//! bar that lands in the wrong place is worse than no bar.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL, WH_MOUSE_LL,
    WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MOUSEWHEEL, WM_RBUTTONDOWN,
    WM_SYSKEYDOWN,
};

use super::{clipboard, uia};
use crate::platform::{classify_probe, Point, Rect, SelectionConfig, SelectionProbe};

/// `HC_ACTION`: the hook may process this event. Any other code means "pass it
/// straight on".
const HC_ACTION_CODE: i32 = 0;

/// Minimum drag distance, in physical pixels, before a click-drag counts as a
/// selection rather than a click.
const DRAG_THRESHOLD_PX: i32 = 6;

/// How long to wait after mouse-up before asking UI Automation. Apps commit
/// the selection asynchronously; probing immediately reads the *previous*
/// selection in Chromium and Office.
const SETTLE_DELAY: Duration = Duration::from_millis(120);

/// What the watcher tells the app to do.
#[derive(Debug, Clone)]
pub enum SelectionEvent {
    /// Show the action bar at `at`. `text` is `Some` when UI Automation could
    /// read the selection outright; `None` means it must be resolved on click.
    Show { at: Point, text: Option<String> },
    /// Hide the action bar — the user clicked, scrolled, or typed elsewhere.
    Dismiss,
}

enum Request {
    Gesture {
        at: Point,
        /// Whether the pointer travelled far enough for this to be a drag.
        dragged: bool,
        /// Value of [`GESTURE_SEQ`] when this gesture was queued.
        seq: u64,
    },
    Dismiss,
    /// Resolve the current selection now and answer on the channel.
    Resolve(Sender<Option<String>>),
}

// --- Hook-thread state -----------------------------------------------------
//
// Low-level hook callbacks are plain `extern "system"` functions with no user
// data parameter, so their state has to be global.

static REQUESTS: OnceLock<Mutex<Sender<Request>>> = OnceLock::new();
static DRAG_ACTIVE: AtomicBool = AtomicBool::new(false);
static DRAG_START_X: AtomicI32 = AtomicI32::new(0);
static DRAG_START_Y: AtomicI32 = AtomicI32::new(0);
/// Bumped on every gesture so the worker can tell that the gesture it slept
/// through has been superseded — without consuming queued messages to find out.
static GESTURE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Screen rect of the action bar while it is visible. Clicks inside it must
/// not dismiss it — the dismissal would race the button's own click handler.
static BAR_RECT: Mutex<Option<Rect>> = Mutex::new(None);

fn send(request: Request) {
    if let Some(tx) = REQUESTS.get() {
        let _ = tx.lock().send(request);
    }
}

/// Tell the watcher where the action bar currently is, or `None` once hidden.
pub fn set_bar_rect(rect: Option<Rect>) {
    *BAR_RECT.lock() = rect;
}

fn point_is_in_bar(at: Point) -> bool {
    BAR_RECT.lock().is_some_and(|r| r.contains(at))
}

/// # Safety
/// Invoked by Windows as a `WH_MOUSE_LL` callback; `lparam` points to a live
/// `MSLLHOOKSTRUCT` for the duration of the call.
unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION_CODE {
        let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        let at = Point {
            x: info.pt.x,
            y: info.pt.y,
        };
        let inside_bar = point_is_in_bar(at);

        match wparam.0 as u32 {
            WM_LBUTTONDOWN if !inside_bar => {
                DRAG_ACTIVE.store(true, Ordering::Relaxed);
                DRAG_START_X.store(at.x, Ordering::Relaxed);
                DRAG_START_Y.store(at.y, Ordering::Relaxed);
                send(Request::Dismiss);
            }
            WM_LBUTTONUP => {
                if DRAG_ACTIVE.swap(false, Ordering::Relaxed) && !inside_bar {
                    let dx = at.x - DRAG_START_X.load(Ordering::Relaxed);
                    let dy = at.y - DRAG_START_Y.load(Ordering::Relaxed);
                    let dragged = dx.abs() >= DRAG_THRESHOLD_PX || dy.abs() >= DRAG_THRESHOLD_PX;
                    let seq = GESTURE_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
                    // Plain clicks are still probed: a double-click selects a
                    // word, and UI Automation reports that as a real selection.
                    send(Request::Gesture { at, dragged, seq });
                }
            }
            WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_MOUSEWHEEL if !inside_bar => {
                send(Request::Dismiss);
            }
            _ => {}
        }
    }
    // Never swallow input: this hook observes, it does not intercept.
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// # Safety
/// Invoked by Windows as a `WH_KEYBOARD_LL` callback; `lparam` points to a
/// live `KBDLLHOOKSTRUCT` for the duration of the call.
unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION_CODE {
        let message = wparam.0 as u32;
        if message == WM_KEYDOWN || message == WM_SYSKEYDOWN {
            let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            // Modifier presses alone don't dismiss: the user may be reaching
            // for Ctrl+C, or for the translate hotkey itself.
            if !is_modifier(info.vkCode) {
                send(Request::Dismiss);
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// `VK_SHIFT`/`VK_CONTROL`/`VK_MENU`, their sided variants, and both Windows
/// keys.
fn is_modifier(vk: u32) -> bool {
    matches!(vk, 0x10..=0x12 | 0x5B | 0x5C | 0xA0..=0xA5)
}

/// Start the watcher. Returns immediately; both threads run for the life of
/// the process.
///
/// `config` is read fresh on every gesture, and `on_event` is called from the
/// worker thread.
pub fn start<C, F>(config: C, on_event: F)
where
    C: Fn() -> SelectionConfig + Send + 'static,
    F: Fn(SelectionEvent) + Send + 'static,
{
    let (tx, rx) = channel::<Request>();
    if REQUESTS.set(Mutex::new(tx)).is_err() {
        log::warn!("the selection watcher is already running");
        return;
    }

    thread::Builder::new()
        .name("lumen-selection-hooks".into())
        .spawn(hook_thread)
        .expect("spawn selection hook thread");

    thread::Builder::new()
        .name("lumen-selection-worker".into())
        .spawn(move || worker_thread(rx, config, on_event))
        .expect("spawn selection worker thread");
}

fn hook_thread() {
    // SAFETY: a null module handle is correct for a hook procedure inside this
    // process, and the hooks stay installed for the life of the thread.
    unsafe {
        let mouse: HHOOK = match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0) {
            Ok(h) => h,
            Err(err) => {
                log::error!("could not install the mouse hook: {err}");
                return;
            }
        };
        let keyboard: HHOOK = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), None, 0)
        {
            Ok(h) => h,
            Err(err) => {
                log::error!("could not install the keyboard hook: {err}");
                let _ = UnhookWindowsHookEx(mouse);
                return;
            }
        };
        log::debug!("selection hooks installed ({mouse:?}, {keyboard:?})");

        // Low-level hooks are only serviced while their thread pumps messages.
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn worker_thread<C, F>(rx: Receiver<Request>, config: C, on_event: F)
where
    C: Fn() -> SelectionConfig,
    F: Fn(SelectionEvent),
{
    uia::init_thread();

    while let Ok(request) = rx.recv() {
        match request {
            Request::Dismiss => on_event(SelectionEvent::Dismiss),
            Request::Resolve(reply) => {
                let cfg = config();
                let _ = reply.send(resolve_now(cfg.clipboard_fallback));
            }
            Request::Gesture { at, dragged, seq } => {
                let cfg = config();
                if !cfg.enabled {
                    continue;
                }
                thread::sleep(SETTLE_DELAY);
                // A newer gesture arrived while we were settling; that one
                // will be handled on its own turn.
                if GESTURE_SEQ.load(Ordering::Relaxed) != seq {
                    continue;
                }
                if let Some(event) = classify(at, dragged, cfg) {
                    on_event(event);
                }
            }
        }
    }
}

fn classify(at: Point, dragged: bool, cfg: SelectionConfig) -> Option<SelectionEvent> {
    classify_probe(uia::probe_selection(), dragged, cfg)
        .map(|text| SelectionEvent::Show { at, text })
}

/// Read the selection right now: UI Automation first, clipboard second.
fn resolve_now(clipboard_fallback: bool) -> Option<String> {
    if let SelectionProbe::Text(text) = uia::probe_selection() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if clipboard_fallback {
        return clipboard::copy_selection().map(|t| t.trim().to_string());
    }
    None
}

/// How long to wait for the worker to answer a resolve request. Generous
/// because the clipboard fallback itself waits up to 400 ms for the focused
/// app to service Ctrl+C.
const RESOLVE_TIMEOUT: Duration = Duration::from_millis(1500);

/// Resolve the current selection, blocking the caller.
///
/// Runs on the watcher's worker thread so UI Automation always sees the same
/// COM apartment and the cached automation client, rather than paying for a
/// fresh one on whichever async-runtime thread the command landed on.
pub fn resolve_selection() -> Option<String> {
    let (reply_tx, reply_rx) = channel();
    send(Request::Resolve(reply_tx));
    match reply_rx.recv_timeout(RESOLVE_TIMEOUT) {
        Ok(text) => text,
        Err(err) => {
            log::warn!("selection resolve timed out: {err}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modifiers_do_not_dismiss_the_bar() {
        for vk in [0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA2, 0xA4, 0xA5] {
            assert!(is_modifier(vk), "expected {vk:#x} to be a modifier");
        }
    }

    #[test]
    fn ordinary_keys_dismiss_the_bar() {
        // 'A', Escape, F1, Space, and the arrow keys all count as typing.
        for vk in [0x41, 0x1B, 0x70, 0x20, 0x25, 0x28] {
            assert!(!is_modifier(vk), "expected {vk:#x} not to be a modifier");
        }
    }

    #[test]
    fn bar_rect_gates_clicks_on_our_own_window() {
        set_bar_rect(Some(Rect {
            left: 100,
            top: 100,
            right: 200,
            bottom: 140,
        }));
        assert!(point_is_in_bar(Point { x: 150, y: 120 }));
        assert!(!point_is_in_bar(Point { x: 250, y: 120 }));
        set_bar_rect(None);
        assert!(!point_is_in_bar(Point { x: 150, y: 120 }));
    }
}

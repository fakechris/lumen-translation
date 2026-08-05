//! Win32 clipboard access, and the synthesised-Ctrl+C fallback for reading a
//! selection out of an app that exposes no accessible text.
//!
//! This path is deliberately the *second* choice — [`super::uia`] is tried
//! first — because it is observable by the user: it briefly replaces the
//! clipboard and sends keystrokes to whatever is focused. When it does run,
//! the previous Unicode text is restored afterwards.
//!
//! Known limitation: only `CF_UNICODETEXT` is preserved. If the clipboard held
//! an image, a file list, or rich text, that content is lost. Users who can't
//! accept that can turn the fallback off in Preferences → Selection.

use std::thread::sleep;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
    SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_C, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};

/// `CF_UNICODETEXT`. Spelled out rather than imported because the constant has
/// moved between modules across `windows` crate releases; the value is fixed
/// by the Win32 ABI.
const CF_UNICODETEXT: u32 = 13;

/// The clipboard is a single global resource; another process can hold it open
/// for a few milliseconds at a time (clipboard managers are the usual culprit).
const OPEN_ATTEMPTS: u32 = 10;
const OPEN_RETRY_DELAY: Duration = Duration::from_millis(20);

/// Holds the clipboard open and guarantees `CloseClipboard` on every exit path.
struct ClipboardGuard;

impl ClipboardGuard {
    fn open() -> Option<Self> {
        for _ in 0..OPEN_ATTEMPTS {
            // SAFETY: passing no owner window is valid and ties the clipboard
            // to the current task.
            if unsafe { OpenClipboard(None) }.is_ok() {
                return Some(Self);
            }
            sleep(OPEN_RETRY_DELAY);
        }
        log::warn!("clipboard is owned by another process; giving up");
        None
    }
}

impl Drop for ClipboardGuard {
    fn drop(&mut self) {
        // SAFETY: only constructed after a successful OpenClipboard.
        let _ = unsafe { CloseClipboard() };
    }
}

/// Read `CF_UNICODETEXT` from the clipboard.
pub fn read_text() -> Option<String> {
    let _guard = ClipboardGuard::open()?;
    unsafe {
        let handle = GetClipboardData(CF_UNICODETEXT).ok()?;
        let global = HGLOBAL(handle.0);
        let ptr = GlobalLock(global) as *const u16;
        if ptr.is_null() {
            return None;
        }
        // The buffer is NUL-terminated UTF-16; GlobalSize rounds up to the
        // allocation granularity, so trust the terminator, not the size.
        let mut len = 0usize;
        while *ptr.add(len) != 0 {
            len += 1;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
        let _ = GlobalUnlock(global);
        Some(text)
    }
}

/// Replace the clipboard with `text`, discarding any other formats.
pub fn write_text(text: &str) -> bool {
    let mut utf16: Vec<u16> = text.encode_utf16().collect();
    utf16.push(0);
    let bytes = std::mem::size_of_val(utf16.as_slice());

    let _guard = match ClipboardGuard::open() {
        Some(g) => g,
        None => return false,
    };
    unsafe {
        if EmptyClipboard().is_err() {
            return false;
        }
        let Ok(global) = GlobalAlloc(GMEM_MOVEABLE, bytes) else {
            return false;
        };
        let dst = GlobalLock(global) as *mut u16;
        if dst.is_null() {
            return false;
        }
        std::ptr::copy_nonoverlapping(utf16.as_ptr(), dst, utf16.len());
        let _ = GlobalUnlock(global);
        // On success the clipboard owns the allocation, so it must not be
        // freed here.
        SetClipboardData(CF_UNICODETEXT, Some(HANDLE(global.0))).is_ok()
    }
}

/// Monotonic counter bumped by Windows on every clipboard change. Comparing it
/// is far more reliable than comparing contents: copying the same text twice
/// still bumps the sequence number.
fn sequence_number() -> u32 {
    // SAFETY: no arguments, no failure mode.
    unsafe { GetClipboardSequenceNumber() }
}

/// How long to wait for the focused app to service our synthetic Ctrl+C.
const COPY_TIMEOUT: Duration = Duration::from_millis(400);
const COPY_POLL: Duration = Duration::from_millis(15);

/// Synthesise Ctrl+C in the focused window and return whatever text lands on
/// the clipboard, restoring the previous text afterwards.
///
/// Returns `None` when the app never copied anything — which is the common,
/// harmless case of "there was no selection after all".
pub fn copy_selection() -> Option<String> {
    let previous = read_text();
    let before = sequence_number();

    send_ctrl_c();

    let deadline = Instant::now() + COPY_TIMEOUT;
    let mut copied = None;
    while Instant::now() < deadline {
        sleep(COPY_POLL);
        if sequence_number() != before {
            copied = read_text();
            break;
        }
    }

    // Restore only if we actually disturbed the clipboard. Rewriting it when
    // nothing changed would bump the sequence number for no reason and make
    // clipboard-history tools show a spurious entry.
    if copied.is_some() {
        match previous {
            Some(text) if !text.is_empty() => {
                write_text(&text);
            }
            // The clipboard was empty (or held a non-text format we can't
            // reproduce) before we started. Leaving our copy in place is the
            // lesser evil versus clearing content we never captured.
            _ => {}
        }
    }

    copied.filter(|t| !t.trim().is_empty())
}

/// Press and release Ctrl+C, first releasing any modifier the user is still
/// holding. Without that, a user who triggers the hotkey with Alt down would
/// have us send Ctrl+Alt+C, which many apps bind to something else.
fn send_ctrl_c() {
    let mut inputs: Vec<INPUT> = Vec::with_capacity(10);
    for vk in [VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN] {
        if is_down(vk) {
            inputs.push(key(vk, true));
        }
    }
    inputs.push(key(VK_CONTROL, false));
    inputs.push(key(VK_C, false));
    inputs.push(key(VK_C, true));
    inputs.push(key(VK_CONTROL, true));

    // SAFETY: `inputs` is a well-formed slice of INPUT records and the size
    // argument matches the struct the API expects.
    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        log::warn!("SendInput delivered {sent}/{} events", inputs.len());
    }
}

fn is_down(vk: VIRTUAL_KEY) -> bool {
    // SAFETY: reading async key state has no preconditions.
    (unsafe { GetAsyncKeyState(vk.0 as i32) } as u16 & 0x8000) != 0
}

fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_round_trips_through_the_clipboard() {
        // Unicode beyond the BMP exercises the UTF-16 surrogate path.
        let sample = "翻訳 test 🌤";
        assert!(write_text(sample));
        assert_eq!(read_text().as_deref(), Some(sample));
    }

    #[test]
    fn sequence_number_advances_on_write() {
        let before = sequence_number();
        assert!(write_text("lumen sequence probe"));
        assert_ne!(sequence_number(), before);
    }
}

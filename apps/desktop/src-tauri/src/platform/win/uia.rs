//! Reading the current selection through UI Automation.
//!
//! This is the non-invasive path and always the first thing tried: it does not
//! touch the clipboard, does not synthesise keystrokes, and works in anything
//! that implements `TextPattern` — Win32 edits, RichEdit, WinUI/UWP, Office,
//! and Chromium/Electron once a UIA client asks for accessibility (asking is
//! what wakes Chromium's tree up, which is exactly what this does).
//!
//! Everything here must run on a COM-initialised thread; call
//! [`init_thread`] once before the first probe.

use std::cell::RefCell;

use windows::core::Interface;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern,
    UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_TextControlTypeId, UIA_TextPatternId,
};

use crate::platform::SelectionProbe;

thread_local! {
    /// One automation client per worker thread. Creating it costs a few
    /// milliseconds, which is too much to pay on every selection gesture.
    static AUTOMATION: RefCell<Option<IUIAutomation>> = const { RefCell::new(None) };
}

/// Initialise COM for the calling thread. Safe to call more than once.
pub fn init_thread() {
    // SAFETY: no preconditions. An `RPC_E_CHANGED_MODE` result means the
    // thread was already initialised in another apartment, which for our
    // read-only use is still workable, so the HRESULT is intentionally not
    // treated as fatal.
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if hr.is_err() {
        log::debug!("CoInitializeEx returned {hr:?}; continuing with the existing apartment");
    }
}

fn automation() -> Option<IUIAutomation> {
    AUTOMATION.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            // SAFETY: CUIAutomation is an in-process COM server present on
            // every supported Windows version.
            match unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
                Ok(a) => *slot = Some(a),
                Err(err) => log::warn!("could not create the UI Automation client: {err}"),
            }
        }
        slot.clone()
    })
}

/// Whether an element is the kind of thing a text selection can live in.
///
/// Used to decide if the action bar should appear when the selection itself
/// can't be read: a caret in a Notepad edit is worth offering to translate, a
/// focused button is not.
fn is_text_like(element: &IUIAutomationElement) -> bool {
    // SAFETY: `element` is a live COM pointer for the duration of the call.
    let Ok(control_type) = (unsafe { element.CurrentControlType() }) else {
        return false;
    };
    // Compared with `==` rather than matched: the UIA constants are not
    // SCREAMING_CASE, and in a pattern position Rust would silently treat them
    // as fresh bindings if the import ever went away — making this function
    // return `true` for every control, including buttons and password fields.
    control_type == UIA_EditControlTypeId
        || control_type == UIA_DocumentControlTypeId
        || control_type == UIA_TextControlTypeId
}

/// Never offer to translate a password field, and never read one.
fn is_password(element: &IUIAutomationElement) -> bool {
    // SAFETY: `element` is a live COM pointer for the duration of the call.
    unsafe { element.CurrentIsPassword() }
        .map(|b| b.as_bool())
        .unwrap_or(false)
}

/// Concatenate every selected range of a text pattern.
fn selection_text(pattern: &IUIAutomationTextPattern) -> Option<String> {
    // SAFETY: `pattern` is a live COM pointer; `GetText(-1)` means "no limit".
    unsafe {
        let ranges = pattern.GetSelection().ok()?;
        let count = ranges.Length().ok()?;
        let mut out = String::new();
        for i in 0..count {
            let Ok(range) = ranges.GetElement(i) else {
                continue;
            };
            if let Ok(text) = range.GetText(-1) {
                out.push_str(&text.to_string());
            }
        }
        Some(out)
    }
}

/// Inspect the focused element and report what can be determined about its
/// selection.
pub fn probe_selection() -> SelectionProbe {
    let Some(automation) = automation() else {
        return SelectionProbe::None;
    };
    // SAFETY: `automation` is a live COM pointer.
    let Ok(element) = (unsafe { automation.GetFocusedElement() }) else {
        return SelectionProbe::None;
    };

    if is_password(&element) {
        return SelectionProbe::None;
    }

    // SAFETY: `element` is live; a missing pattern surfaces as an error or a
    // null interface rather than UB.
    let pattern = unsafe { element.GetCurrentPattern(UIA_TextPatternId) }
        .ok()
        .and_then(|unknown| unknown.cast::<IUIAutomationTextPattern>().ok());

    match pattern {
        Some(pattern) => match selection_text(&pattern) {
            Some(text) if !text.trim().is_empty() => SelectionProbe::Text(text),
            // The control speaks TextPattern but reports an empty selection.
            // Some providers (notably older Chromium builds) only populate the
            // range after a client has asked once, so treat this as "probably
            // a selection" rather than "definitely nothing".
            _ => SelectionProbe::Likely,
        },
        None if is_text_like(&element) => SelectionProbe::Likely,
        None => SelectionProbe::None,
    }
}

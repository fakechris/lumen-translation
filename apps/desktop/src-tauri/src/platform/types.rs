//! Platform-neutral value types shared by the Windows implementation and its
//! non-Windows stubs.

/// Screen point in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// Screen rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }

    pub fn contains(&self, p: Point) -> bool {
        p.x >= self.left && p.x < self.right && p.y >= self.top && p.y < self.bottom
    }

    /// Move `size` so it sits entirely inside `self`, preferring the requested
    /// origin. Used to keep both the action bar and the translation window on
    /// screen, mirroring `constrainFrameRect` on macOS.
    pub fn clamp(&self, origin: Point, width: i32, height: i32) -> Point {
        let x = origin.x.min(self.right - width).max(self.left);
        let y = origin.y.min(self.bottom - height).max(self.top);
        Point { x, y }
    }
}

/// What a selection probe could determine about the focused control.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectionProbe {
    /// UI Automation read the selection directly. No clipboard involved.
    Text(String),
    /// The focused element is a text control, but its selection could not be
    /// read (no `TextPattern`, or a provider that reports an empty range).
    /// Enough to justify showing the action bar; the text is resolved on click.
    Likely,
    /// Nothing text-like is focused — do not show the action bar.
    None,
}

/// How the selection watcher should behave right now. Read fresh on every
/// gesture so Preferences changes take effect without restarting the hooks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SelectionConfig {
    pub enabled: bool,
    pub clipboard_fallback: bool,
    pub min_chars: usize,
}

/// Decide whether a settled gesture should raise the action bar.
///
/// `Some(Some(text))` — show the bar, the text is already known.
/// `Some(None)`       — show the bar, resolve the text when it is clicked.
/// `None`             — do not show the bar.
///
/// Lives here, away from the Win32 code, because this is the policy that gets
/// tuned and it deserves tests that run on any host.
pub fn classify_probe(
    probe: SelectionProbe,
    dragged: bool,
    cfg: SelectionConfig,
) -> Option<Option<String>> {
    match probe {
        // A real, readable selection always wins, however it was made: this
        // covers double-click-a-word as well as drag-select.
        SelectionProbe::Text(text) if text.chars().count() >= cfg.min_chars => Some(Some(text)),
        SelectionProbe::Text(_) => None,
        // We can't read the text. Only a *drag* justifies a speculative bar —
        // otherwise every single click into a text field would raise one — and
        // only if clicking it would actually be able to resolve the text.
        SelectionProbe::Likely if dragged && cfg.clipboard_fallback => Some(None),
        SelectionProbe::Likely | SelectionProbe::None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CFG: SelectionConfig = SelectionConfig {
        enabled: true,
        clipboard_fallback: true,
        min_chars: 1,
    };

    const SCREEN: Rect = Rect {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
    };

    #[test]
    fn clamp_keeps_a_window_fully_on_screen() {
        assert_eq!(
            SCREEN.clamp(Point { x: 1900, y: 1070 }, 200, 40),
            Point { x: 1720, y: 1040 }
        );
        assert_eq!(
            SCREEN.clamp(Point { x: -50, y: -20 }, 200, 40),
            Point { x: 0, y: 0 }
        );
        assert_eq!(
            SCREEN.clamp(Point { x: 100, y: 100 }, 200, 40),
            Point { x: 100, y: 100 }
        );
    }

    #[test]
    fn clamp_prefers_the_left_top_edge_when_the_window_is_too_large() {
        // A window wider than the monitor must still start at the left edge
        // rather than being pushed off to a negative origin.
        assert_eq!(
            SCREEN.clamp(Point { x: 500, y: 500 }, 3000, 2000),
            Point { x: 0, y: 0 }
        );
    }

    #[test]
    fn contains_is_half_open_on_the_far_edges() {
        assert!(SCREEN.contains(Point { x: 0, y: 0 }));
        assert!(!SCREEN.contains(Point { x: 1920, y: 0 }));
        assert!(!SCREEN.contains(Point { x: 0, y: 1080 }));
    }

    #[test]
    fn readable_selection_shows_the_bar_however_it_was_made() {
        let probe = SelectionProbe::Text("hello".into());
        assert_eq!(
            classify_probe(probe.clone(), true, CFG),
            Some(Some("hello".into()))
        );
        // Double-click: no drag, but a real selection.
        assert_eq!(
            classify_probe(probe, false, CFG),
            Some(Some("hello".into()))
        );
    }

    #[test]
    fn selections_below_the_minimum_length_are_ignored() {
        let cfg = SelectionConfig {
            min_chars: 3,
            ..CFG
        };
        assert_eq!(
            classify_probe(SelectionProbe::Text("ab".into()), true, cfg),
            None
        );
        assert_eq!(
            classify_probe(SelectionProbe::Text("abc".into()), true, cfg),
            Some(Some("abc".into()))
        );
    }

    #[test]
    fn min_chars_counts_characters_not_bytes() {
        let cfg = SelectionConfig {
            min_chars: 2,
            ..CFG
        };
        // "翻" is three UTF-8 bytes but one character, so it must not pass a
        // two-character minimum.
        assert_eq!(
            classify_probe(SelectionProbe::Text("翻".into()), true, cfg),
            None
        );
        assert_eq!(
            classify_probe(SelectionProbe::Text("翻译".into()), true, cfg),
            Some(Some("翻译".into()))
        );
    }

    #[test]
    fn a_plain_click_never_raises_a_speculative_bar() {
        // This is what makes the feature usable: without it, every click into
        // any text field would pop the bar.
        assert_eq!(classify_probe(SelectionProbe::Likely, false, CFG), None);
    }

    #[test]
    fn a_drag_raises_a_speculative_bar_only_with_the_clipboard_fallback() {
        assert_eq!(
            classify_probe(SelectionProbe::Likely, true, CFG),
            Some(None)
        );
        let no_fallback = SelectionConfig {
            clipboard_fallback: false,
            ..CFG
        };
        assert_eq!(
            classify_probe(SelectionProbe::Likely, true, no_fallback),
            None
        );
    }

    #[test]
    fn non_text_focus_never_raises_the_bar() {
        assert_eq!(classify_probe(SelectionProbe::None, true, CFG), None);
        assert_eq!(classify_probe(SelectionProbe::None, false, CFG), None);
    }
}

//! Persisted settings — the Windows counterpart of `Preferences.swift`.
//!
//! macOS stores these in `UserDefaults`. Here they live in
//! `%APPDATA%\Lumen Translation\settings.json`, owned by Rust rather than by
//! the webview because the backend needs them too: the tray's Engine submenu
//! writes `providerId`, and the selection watcher reads its own toggles.
//!
//! API keys are encrypted at rest with DPAPI (see [`crate::platform::secret`]),
//! so a settings file copied off the machine — or synced by accident — is not
//! a set of live credentials. Values that fail to decrypt are dropped rather
//! than surfaced as garbage.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::platform::secret;

/// Marks a value in the on-disk file as DPAPI-encrypted base64.
const SECRET_PREFIX: &str = "dpapi:";

/// A user-defined OpenAI-compatible endpoint slot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CustomProvider {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, rename = "baseURL")]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub provider_id: String,
    /// Per-provider API keys, keyed by canonical provider id.
    pub api_keys: BTreeMap<String, String>,
    /// Per-provider model overrides.
    pub models: BTreeMap<String, String>,
    /// `None` means auto-detect from locale / time zone.
    pub region: Option<String>,
    pub source_lang: String,
    pub target_lang: String,
    pub custom_providers: Vec<CustomProvider>,
    pub selection_popup_enabled: bool,
    pub selection_clipboard_fallback: bool,
    pub min_selection_chars: usize,
    pub max_selection_chars: usize,
    pub launch_at_login: bool,
    pub hotkey_show_last: String,
    pub hotkey_translate_selection: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            provider_id: "google_translate".into(),
            api_keys: BTreeMap::new(),
            models: BTreeMap::new(),
            region: None,
            source_lang: "auto".into(),
            target_lang: "zh-CN".into(),
            custom_providers: Vec::new(),
            selection_popup_enabled: true,
            selection_clipboard_fallback: true,
            min_selection_chars: 1,
            max_selection_chars: 5000,
            launch_at_login: false,
            hotkey_show_last: "Alt+Ctrl+L".into(),
            hotkey_translate_selection: "Alt+Ctrl+T".into(),
        }
    }
}

/// Load settings from `path`, decrypting API keys.
///
/// A missing file yields defaults (first run). A corrupt file also yields
/// defaults rather than failing the launch — a tray app that refuses to start
/// because of a bad JSON byte is worse than one that forgets its settings —
/// but the corrupt file is preserved alongside as `settings.json.bak` so the
/// user can recover their API keys by hand.
pub fn load(path: &Path) -> Settings {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return Settings::default(),
    };
    let mut settings: Settings = match serde_json::from_str(&raw) {
        Ok(s) => s,
        Err(err) => {
            log::error!("settings file is corrupt ({err}); starting from defaults");
            let _ = fs::write(path.with_extension("json.bak"), &raw);
            return Settings::default();
        }
    };
    settings.api_keys = settings
        .api_keys
        .into_iter()
        .filter_map(|(id, value)| decrypt_key(&value).map(|plain| (id, plain)))
        .collect();
    settings
}

/// Write settings to `path`, encrypting API keys. Creates the parent directory.
pub fn save(path: &Path, settings: &Settings) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut on_disk = settings.clone();
    on_disk.api_keys = settings
        .api_keys
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(id, plain)| (id.clone(), encrypt_key(plain)))
        .collect();
    let json = serde_json::to_string_pretty(&on_disk)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    // Write-then-rename so a crash mid-write can't truncate a file full of
    // API keys.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(&tmp, path)
}

fn encrypt_key(plain: &str) -> String {
    match secret::protect(plain.as_bytes()) {
        Some(bytes) => format!("{SECRET_PREFIX}{}", base64_encode(&bytes)),
        // No DPAPI (non-Windows dev builds): store as-is so the round trip
        // still works. Windows always has it.
        None => plain.to_string(),
    }
}

fn decrypt_key(value: &str) -> Option<String> {
    let Some(encoded) = value.strip_prefix(SECRET_PREFIX) else {
        // Plaintext: either a non-Windows build or a settings file written
        // before encryption existed. It gets re-encrypted on the next save.
        return Some(value.to_string());
    };
    let bytes = base64_decode(encoded)?;
    let plain = secret::unprotect(&bytes)?;
    String::from_utf8(plain).ok()
}

/// Default settings path: `%APPDATA%\Lumen Translation\settings.json`.
pub fn default_path(app_data_dir: PathBuf) -> PathBuf {
    app_data_dir.join("settings.json")
}

// ---------------------------------------------------------------------------
// Minimal base64 — small enough not to justify a dependency, and only ever
// applied to DPAPI blobs.
// ---------------------------------------------------------------------------

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn base64_decode(input: &str) -> Option<Vec<u8>> {
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    for c in input.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' => continue,
            _ => return None,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips_arbitrary_bytes() {
        for len in 0..64usize {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 7 + 13) as u8).collect();
            let encoded = base64_encode(&bytes);
            assert_eq!(base64_decode(&encoded).as_deref(), Some(bytes.as_slice()));
        }
    }

    #[test]
    fn base64_rejects_non_alphabet_input() {
        assert!(base64_decode("not base64!").is_none());
    }

    #[test]
    fn missing_file_yields_defaults() {
        let dir = std::env::temp_dir().join("lumen-settings-missing");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load(&dir.join("settings.json")), Settings::default());
    }

    #[test]
    fn round_trips_through_disk_including_api_keys() {
        let dir = std::env::temp_dir().join("lumen-settings-roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("settings.json");

        let mut settings = Settings {
            provider_id: "deepseek".into(),
            target_lang: "ja".into(),
            ..Default::default()
        };
        settings
            .api_keys
            .insert("deepseek".into(), "sk-secret".into());
        settings.custom_providers.push(CustomProvider {
            id: "custom:abc".into(),
            name: "Local".into(),
            base_url: "http://127.0.0.1:1234/v1".into(),
            model: "qwen".into(),
        });

        save(&path, &settings).expect("save");
        assert_eq!(load(&path), settings);

        // The key must not be readable in the file on Windows, where DPAPI is
        // available. Elsewhere the fallback deliberately stores plaintext.
        let raw = std::fs::read_to_string(&path).expect("read");
        if cfg!(target_os = "windows") {
            assert!(!raw.contains("sk-secret"));
            assert!(raw.contains(SECRET_PREFIX));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_falls_back_to_defaults_and_keeps_a_backup() {
        let dir = std::env::temp_dir().join("lumen-settings-corrupt");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("settings.json");
        std::fs::write(&path, "{ not json").expect("write");

        assert_eq!(load(&path), Settings::default());
        assert!(path.with_extension("json.bak").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

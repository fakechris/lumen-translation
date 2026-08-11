//! Persisted settings — the Windows counterpart of `Preferences.swift`.
//!
//! macOS stores these in `UserDefaults`. Here they live in
//! `%APPDATA%\app.lumen.translation\settings.json`, owned by Rust rather than by
//! the webview because the backend needs them too: the tray's Engine submenu
//! writes `providerId`, and the selection watcher reads its own toggles.
//!
//! API keys are encrypted at rest with DPAPI (see [`crate::platform::secret`]),
//! so a settings file copied off the machine — or synced by accident — is not
//! a set of live credentials. Values that fail to decrypt are dropped rather
//! than surfaced as garbage.

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
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
    let mut decrypted = BTreeMap::new();
    let mut dropped = Vec::new();
    for (id, value) in settings.api_keys {
        match decrypt_key(&value) {
            Some(plain) => {
                decrypted.insert(id, plain);
            }
            None => dropped.push(id),
        }
    }
    if !dropped.is_empty() {
        log::error!(
            "could not decrypt API keys for providers {}; preserving the original file as settings.json.dpapi.bak",
            dropped.join(", ")
        );
        let _ = fs::write(path.with_extension("json.dpapi.bak"), &raw);
    }
    settings.api_keys = decrypted;
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
        .map(|(id, plain)| encrypt_key(plain).map(|encrypted| (id.clone(), encrypted)))
        .collect::<std::io::Result<_>>()?;
    let json = serde_json::to_string_pretty(&on_disk)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    // Write-then-rename so a crash mid-write can't truncate a file full of
    // API keys.
    let tmp = path.with_extension("json.tmp");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&tmp)?;
    file.write_all(json.as_bytes())?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path)
}

fn encrypt_key(plain: &str) -> std::io::Result<String> {
    match secret::protect(plain.as_bytes()) {
        Some(bytes) => Ok(format!("{SECRET_PREFIX}{}", BASE64.encode(bytes))),
        // No DPAPI (non-Windows dev builds): store as-is so the round trip
        // still works. Windows always has it.
        None if !cfg!(target_os = "windows") => Ok(plain.to_string()),
        None => Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "DPAPI refused to encrypt an API key; settings were not written",
        )),
    }
}

fn decrypt_key(value: &str) -> Option<String> {
    let Some(encoded) = value.strip_prefix(SECRET_PREFIX) else {
        // Plaintext: either a non-Windows build or a settings file written
        // before encryption existed. It gets re-encrypted on the next save.
        return Some(value.to_string());
    };
    let bytes = BASE64.decode(encoded).ok()?;
    let plain = secret::unprotect(&bytes)?;
    String::from_utf8(plain).ok()
}

/// Default settings path: `%APPDATA%\app.lumen.translation\settings.json`.
pub fn default_path(app_data_dir: PathBuf) -> PathBuf {
    app_data_dir.join("settings.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

    fn test_dir(name: &str) -> PathBuf {
        let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "lumen-settings-{name}-{}-{seq}",
            std::process::id()
        ))
    }

    #[test]
    fn invalid_encrypted_value_is_rejected() {
        assert!(decrypt_key("dpapi:not base64!").is_none());
    }

    #[test]
    fn missing_file_yields_defaults() {
        let dir = test_dir("missing");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load(&dir.join("settings.json")), Settings::default());
    }

    #[test]
    fn round_trips_through_disk_including_api_keys() {
        let dir = test_dir("roundtrip");
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

        // A second write exercises replacement of an existing settings file,
        // including Windows' rename semantics.
        settings.target_lang = "ko".into();
        save(&path, &settings).expect("replace existing settings");
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
        let dir = test_dir("corrupt");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("settings.json");
        std::fs::write(&path, "{ not json").expect("write");

        assert_eq!(load(&path), Settings::default());
        assert!(path.with_extension("json.bak").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

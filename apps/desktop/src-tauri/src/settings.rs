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

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LiveSubtitleCaptureMode {
    /// Capture all current and future system-output processes. This keeps
    /// subtitles alive when the media app is in the background.
    #[default]
    AllSystemAudio,
    /// Capture only the app that is frontmost when subtitles are started.
    FrontmostApp,
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
    pub live_subtitle_capture_mode: LiveSubtitleCaptureMode,
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
            live_subtitle_capture_mode: LiveSubtitleCaptureMode::AllSystemAudio,
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

/// Seed the Tauri runtime from the existing macOS Lumen `UserDefaults` when
/// this desktop port has no JSON settings file yet. The values stay in memory:
/// merely launching live subtitles never copies credentials to another file.
#[cfg(target_os = "macos")]
pub fn overlay_legacy_macos_defaults(settings: &mut Settings) -> usize {
    let mut values = BTreeMap::new();
    for key in [
        "lumen.provider",
        "lumen.region",
        "lumen.sourceLang",
        "lumen.targetLang",
    ] {
        if let Some(value) = macos_preference_string(key) {
            values.insert(key.to_string(), value);
        }
    }

    for id in [
        "google_translate",
        "google",
        "microsoft_translator",
        "microsoft",
        "openai",
        "openrouter",
        "anthropic",
        "kimi",
        "glm",
        "minimax",
        "deepseek",
    ] {
        for prefix in ["lumen.apiKey.", "lumen.model."] {
            let key = format!("{prefix}{id}");
            if let Some(value) = macos_preference_string(&key) {
                values.insert(key, value);
            }
        }
    }

    merge_legacy_macos_values(settings, &values)
}

#[cfg(target_os = "macos")]
fn merge_legacy_macos_values(settings: &mut Settings, values: &BTreeMap<String, String>) -> usize {
    fn canonical_id(id: &str) -> &str {
        match id {
            "google" => "google_translate",
            "microsoft" => "microsoft_translator",
            "anthropic" => "openrouter",
            other => other,
        }
    }

    let mut imported = 0;
    if let Some(provider) = values
        .get("lumen.provider")
        .filter(|value| !value.is_empty())
    {
        settings.provider_id = canonical_id(provider).to_string();
        imported += 1;
    }
    if let Some(region) = values.get("lumen.region").filter(|value| !value.is_empty()) {
        settings.region = Some(region.clone());
        imported += 1;
    }
    if let Some(source) = values
        .get("lumen.sourceLang")
        .filter(|value| !value.is_empty())
    {
        settings.source_lang = source.clone();
        imported += 1;
    }
    if let Some(target) = values
        .get("lumen.targetLang")
        .filter(|value| !value.is_empty())
    {
        settings.target_lang = target.clone();
        imported += 1;
    }

    for (key, value) in values {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if let Some(id) = key.strip_prefix("lumen.apiKey.") {
            let canonical = canonical_id(id).to_string();
            if canonical != id && values.contains_key(&format!("lumen.apiKey.{canonical}")) {
                continue;
            }
            settings.api_keys.entry(canonical).or_insert_with(|| {
                imported += 1;
                value.to_string()
            });
        } else if let Some(id) = key.strip_prefix("lumen.model.") {
            let canonical = canonical_id(id).to_string();
            if canonical != id && values.contains_key(&format!("lumen.model.{canonical}")) {
                continue;
            }
            settings.models.entry(canonical).or_insert_with(|| {
                imported += 1;
                value.to_string()
            });
        }
    }
    imported
}

#[cfg(target_os = "macos")]
fn macos_preference_string(key: &str) -> Option<String> {
    use std::ffi::{c_char, c_void, CStr, CString};

    type CFStringRef = *const c_void;
    type CFPropertyListRef = *const c_void;
    const UTF8: u32 = 0x0800_0100;

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFPreferencesCurrentApplication: CFStringRef;
        fn CFStringCreateWithCString(
            allocator: *const c_void,
            value: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFPreferencesCopyAppValue(key: CFStringRef, app_id: CFStringRef) -> CFPropertyListRef;
        fn CFGetTypeID(value: CFPropertyListRef) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFStringGetCString(
            value: CFStringRef,
            buffer: *mut c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> bool;
        fn CFRelease(value: CFPropertyListRef);
    }

    let key = CString::new(key).ok()?;
    unsafe {
        let key_ref = CFStringCreateWithCString(std::ptr::null(), key.as_ptr(), UTF8);
        if key_ref.is_null() {
            return None;
        }
        let value = CFPreferencesCopyAppValue(key_ref, kCFPreferencesCurrentApplication);
        CFRelease(key_ref);
        if value.is_null() {
            return None;
        }
        if CFGetTypeID(value) != CFStringGetTypeID() {
            CFRelease(value);
            return None;
        }

        let mut buffer = vec![0 as c_char; 65_536];
        let copied = CFStringGetCString(
            value.cast(),
            buffer.as_mut_ptr(),
            buffer.len() as isize,
            UTF8,
        );
        CFRelease(value);
        if !copied {
            return None;
        }
        CStr::from_ptr(buffer.as_ptr())
            .to_str()
            .ok()
            .map(str::to_owned)
    }
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

    #[cfg(target_os = "macos")]
    #[test]
    fn legacy_macos_values_are_canonicalized_without_overwriting_runtime_values() {
        let mut settings = Settings::default();
        settings
            .api_keys
            .insert("openai".into(), "runtime-key".into());
        let values = BTreeMap::from([
            ("lumen.provider".into(), "anthropic".into()),
            ("lumen.sourceLang".into(), "auto".into()),
            ("lumen.targetLang".into(), "zh".into()),
            ("lumen.apiKey.google".into(), "legacy-alias".into()),
            (
                "lumen.apiKey.google_translate".into(),
                "canonical-key".into(),
            ),
            ("lumen.apiKey.openai".into(), "legacy-openai".into()),
        ]);

        merge_legacy_macos_values(&mut settings, &values);

        assert_eq!(settings.provider_id, "openrouter");
        assert_eq!(settings.target_lang, "zh");
        assert_eq!(settings.api_keys["google_translate"], "canonical-key");
        assert_eq!(settings.api_keys["openai"], "runtime-key");
    }

    #[test]
    fn missing_file_yields_defaults() {
        let dir = test_dir("missing");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load(&dir.join("settings.json")), Settings::default());
    }

    #[test]
    fn old_settings_default_live_subtitles_to_all_system_audio() {
        let settings: Settings = serde_json::from_str(r#"{"providerId":"deepseek"}"#).unwrap();

        assert_eq!(
            settings.live_subtitle_capture_mode,
            LiveSubtitleCaptureMode::AllSystemAudio
        );
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

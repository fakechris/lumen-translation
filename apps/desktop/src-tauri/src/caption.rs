//! Live-subtitle pipeline (macOS): tap the frontmost app's audio →
//! streaming Paraformer → `caption-final` events, refined in the background
//! by MLX Whisper → `caption-refine` events.
//!
//! Two-pass captions, mirroring the cluster research (WhisperLiveKit style):
//!
//! * **Pass 1 (instant)** — streaming Paraformer partials and finals reach
//!   the overlay in under a second.
//! * **Pass 2 (accurate)** — each finalized utterance's 16 kHz audio is
//!   queued to a refine thread that re-transcribes it with MLX Whisper
//!   (large-v3-turbo). When Whisper's text differs, a `caption-refine` event
//!   replaces the utterance's on-screen text — before or after the
//!   translation fired, the frontend owns that reconciliation.
//!
//! Threading contract (same as lumen-asr's meeting live layer): one dedicated
//! thread owns the sherpa recognizer and its stream; a second dedicated
//! thread owns the Whisper python worker. The tap sink only pushes into
//! bounded channels.
//!
//! Chunking: finals are split at sentence punctuation (。！？…!? and friends)
//! so the overlay shows caption-shaped lines; any piece longer than 42 chars
//! is hard-cut. Long utterances are still refined as a whole and the refine
//! event collapses their pieces back into one line.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use lumen_asr_engine::AsrEngine as _;

/// The streaming Paraformer model's expected input rate; the tap delivers at
/// its native rate and chunks are linearly resampled to this.
const TARGET_RATE: u32 = 16_000;

/// Bound of the tap → worker audio queue. ~10 s of mono 48 kHz float audio —
/// generous headroom; when full, the sink drops the chunk (captions lag
/// momentarily rather than memory growing without bound).
const AUDIO_QUEUE_CAPACITY: usize = 480;

/// Utterances longer than this are not refined (Whisper pass adds nothing a
/// user will still be watching by then).
const REFINE_MAX_SECONDS: f64 = 30.0;

/// Soft visual width before cutting (1 Chinese char = 2, 1 ASCII char = 1).
/// 60 visual width corresponds to ~30 CJK characters or ~10-14 English words.
const CAPTION_MAX_VISUAL_WIDTH: usize = 60;

const IDLE_POLL: Duration = Duration::from_millis(50);

/// Payload of the `caption-partial` / `caption-final` events.
///
/// `utterance` groups the caption pieces of one endpoint-delimited utterance;
/// a later `caption-refine` for the same `utterance` supersedes all of them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionEvent {
    pub revision: u64,
    pub utterance: u64,
    /// Piece index within the utterance (chunked finals only).
    pub seq: u32,
    pub app_name: String,
    pub text: String,
    pub is_final: bool,
}

/// Payload of `caption-refine`: Whisper's re-transcription of an utterance.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionRefineEvent {
    pub utterance: u64,
    pub app_name: String,
    pub text: String,
}

/// One native caption update. The same envelope is both delivered live to the
/// caption WebView and retained in a short journal for recovery after a
/// hidden/suspended/reloaded WebView misses a transient Tauri event.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "payload", rename_all = "camelCase")]
pub enum CaptionOutput {
    Partial(CaptionEvent),
    Final(CaptionEvent),
    Refine(CaptionRefineEvent),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionJournalEntry {
    pub session_id: u64,
    pub event_id: u64,
    #[serde(flatten)]
    pub output: CaptionOutput,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionJournalSnapshot {
    pub session_id: u64,
    pub entries: Vec<CaptionJournalEntry>,
}

const CAPTION_JOURNAL_LIMIT: usize = 128;

/// Bounded, process-local delivery journal. It contains only already-renderable
/// text, never audio or credentials.
#[derive(Default)]
pub struct CaptionEventJournal {
    session_id: u64,
    next_event_id: u64,
    active: bool,
    entries: VecDeque<CaptionJournalEntry>,
}

impl CaptionEventJournal {
    pub fn begin_session(&mut self) -> u64 {
        self.session_id = self.session_id.saturating_add(1).max(1);
        self.active = true;
        self.entries.clear();
        self.session_id
    }

    pub fn end_session(&mut self) {
        self.active = false;
        self.entries.clear();
    }

    pub fn push(&mut self, output: CaptionOutput) -> CaptionJournalEntry {
        if self.session_id == 0 {
            self.begin_session();
        }
        self.next_event_id = self.next_event_id.saturating_add(1).max(1);
        let entry = CaptionJournalEntry {
            session_id: self.session_id,
            event_id: self.next_event_id,
            output,
        };
        self.entries.push_back(entry.clone());
        while self.entries.len() > CAPTION_JOURNAL_LIMIT {
            self.entries.pop_front();
        }
        entry
    }

    pub fn push_for_session(
        &mut self,
        session_id: u64,
        output: CaptionOutput,
    ) -> Option<CaptionJournalEntry> {
        (self.active && self.session_id == session_id).then(|| self.push(output))
    }

    pub fn snapshot_since(
        &self,
        session_id: Option<u64>,
        after_event_id: u64,
    ) -> CaptionJournalSnapshot {
        let same_session = session_id == Some(self.session_id);
        CaptionJournalSnapshot {
            session_id: self.session_id,
            entries: self
                .entries
                .iter()
                .filter(|entry| !same_session || entry.event_id > after_event_id)
                .cloned()
                .collect(),
        }
    }
}

fn publish_caption(app: &AppHandle, session_id: u64, output: CaptionOutput) {
    let Some(entry) = app
        .state::<crate::AppState>()
        .caption_journal
        .write()
        .push_for_session(session_id, output)
    else {
        return;
    };
    static MISSING_WINDOW_WARNED: AtomicBool = AtomicBool::new(false);
    let Some(_window) = app.get_webview_window(crate::WINDOW_CAPTION) else {
        if !MISSING_WINDOW_WARNED.swap(true, Ordering::Relaxed) {
            log::warn!("caption output journaled but caption window is unavailable");
        }
        return;
    };
    MISSING_WINDOW_WARNED.store(false, Ordering::Relaxed);
    if let Err(error) = app.emit_to(crate::WINDOW_CAPTION, "caption-output", &entry) {
        // The journal is authoritative for delivery; a later frontend pull
        // will recover this entry even if the transient event failed.
        log::warn!("caption live event delivery failed; recovery pull will retry: {error}");
    }
}

/// Owns the running spike session. Cross-platform and `Send + Sync`; every
/// field is only touched while holding the AppState lock.
pub struct CaptionSession {
    inner: Mutex<Option<Worker>>,
}

struct Worker {
    stop: Arc<AtomicBool>,
    capture: Arc<Mutex<lumen_platform_macos::SystemAudioCapture>>,
    refine_stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    refine_handle: Option<JoinHandle<()>>,
}

impl Default for CaptionSession {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

impl CaptionSession {
    pub fn is_running(&self) -> bool {
        self.inner.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    pub fn start(
        &self,
        app: AppHandle,
        session_id: u64,
        target: lumen_platform_macos::SystemAudioTarget,
        app_name: String,
        recognizer: lumen_asr_engine::StreamingRecognizer,
    ) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        // Defensive: reap any stopped-but-unjoined worker first.
        if let Some(mut worker) = guard.take() {
            worker.shutdown();
        }

        let (tx, rx) = std::sync::mpsc::sync_channel(AUDIO_QUEUE_CAPACITY);
        let sink: lumen_platform_macos::SystemAudioSink = Arc::new(move |samples: &[f32]| {
            // Drop-on-full is the designed backpressure: a momentarily lagging
            // caption beats unbounded memory when the model stalls.
            match tx.try_send(samples.to_vec()) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {}
            }
        });

        if target.is_empty() {
            return Err("no valid system-audio target".into());
        }

        let capture = Arc::new(Mutex::new(lumen_platform_macos::SystemAudioCapture::new()));
        let capture_rate = {
            let mut c = capture.lock().map_err(|e| e.to_string())?;
            c.start(&target, sink).map_err(|e| e.to_string())?
        };

        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);

        // Refine thread: MLX Whisper second pass. Created optimistically and
        // poisoned on its first hard failure (no python/mlx-whisper etc.) —
        // captions then run Paraformer-only, which is the documented degrade.
        let (refine_tx, refine_rx) = std::sync::mpsc::sync_channel::<RefineJob>(4);
        let refine_enabled = Arc::new(AtomicBool::new(true));
        let refine_stop = Arc::new(AtomicBool::new(false));
        let refine_handle = {
            let app = app.clone();
            let app_name = app_name.clone();
            let enabled = Arc::clone(&refine_enabled);
            let stop = Arc::clone(&refine_stop);
            std::thread::Builder::new()
                .name("lumen-caption-refine".into())
                .spawn(move || {
                    run_refine_worker(app, session_id, app_name, refine_rx, enabled, stop);
                })
                .ok()
        };

        let handle = std::thread::Builder::new()
            .name("lumen-caption".into())
            .spawn(move || {
                run_worker(
                    app,
                    session_id,
                    recognizer,
                    app_name,
                    capture_rate,
                    rx,
                    refine_tx,
                    refine_enabled,
                    worker_stop,
                );
            })
            .map_err(|e| e.to_string())?;

        *guard = Some(Worker {
            stop,
            capture,
            refine_stop,
            handle: Some(handle),
            refine_handle,
        });
        Ok(())
    }

    pub fn stop(&self) {
        let Ok(mut guard) = self.inner.lock() else {
            return;
        };
        if let Some(mut worker) = guard.take() {
            worker.shutdown();
        }
    }
}

impl Worker {
    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        self.refine_stop.store(true, Ordering::SeqCst);
        // Stopping the tap first ends the sink callbacks; the workers then
        // drain what is left, flush trailing context, and exit.
        if let Ok(mut capture) = self.capture.lock() {
            let _ = capture.stop();
        }
        let _ = self.handle.take().map(JoinHandle::join);
        // MLX Whisper is a blocking subprocess call with a 60 s timeout. Its
        // stop flag prevents any late result from being applied, but joining
        // here would freeze Stop/Quit (and local app replacement) for the
        // whole timeout. Detach it; the process exits on its own shortly.
        drop(self.refine_handle.take());
    }
}

/// One finalized utterance queued to the Whisper refine thread.
struct RefineJob {
    utterance: u64,
    pass1_text: String,
    /// 16 kHz mono f32, the exact samples pass 1 decoded.
    samples: Vec<f32>,
}

fn chunk_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|&s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

fn run_worker(
    app: AppHandle,
    session_id: u64,
    recognizer: lumen_asr_engine::StreamingRecognizer,
    app_name: String,
    capture_rate: u32,
    rx: std::sync::mpsc::Receiver<Vec<f32>>,
    refine_tx: SyncSender<RefineJob>,
    refine_enabled: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) {
    let mut stream = recognizer.new_stream();
    let mut revision: u64 = 0;
    let mut utterance: u64 = 0;
    let mut last_partial = String::new();
    // 16 kHz audio of the utterance in flight, for the Whisper refine pass.
    let mut utterance_samples: Vec<f32> = Vec::new();
    let mut silence_frames: usize = 0;
    const SILENCE_RMS_THRESHOLD: f32 = 0.0012; // ~-58 dB silence gate

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let mut got_audio = false;
        loop {
            match rx.try_recv() {
                Ok(chunk) => {
                    got_audio = true;
                    let samples = if capture_rate == TARGET_RATE {
                        chunk
                    } else {
                        lumen_asr_engine::audio::resample_linear(&chunk, capture_rate, TARGET_RATE)
                    };
                    let is_silent = chunk_rms(&samples) < SILENCE_RMS_THRESHOLD;
                    if is_silent && utterance_samples.is_empty() && last_partial.is_empty() {
                        silence_frames = silence_frames.saturating_add(1);
                        if silence_frames > 60 {
                            // Deep silence when completely idle: skip feeding empty noise frames
                            continue;
                        }
                    } else {
                        silence_frames = 0;
                    }
                    utterance_samples.extend_from_slice(&samples);
                    stream.accept_waveform(&samples, TARGET_RATE);
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
                Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
            }
        }
        if !got_audio {
            std::thread::sleep(IDLE_POLL);
            continue;
        }
        stream.decode();
        revision += 1;
        if stream.is_endpoint() {
            let raw_text = stream.result().text;
            let text = clean_asr_text(&raw_text);
            if !text.trim().is_empty() {
                utterance += 1;
                for (seq, piece) in split_caption_pieces(&text).into_iter().enumerate() {
                    publish_caption(
                        &app,
                        session_id,
                        CaptionOutput::Final(CaptionEvent {
                            revision,
                            utterance,
                            seq: seq as u32,
                            app_name: app_name.clone(),
                            text: piece,
                            is_final: true,
                        }),
                    );
                }
                maybe_enqueue_refine(
                    &refine_tx,
                    &refine_enabled,
                    RefineJob {
                        utterance,
                        pass1_text: text,
                        samples: std::mem::take(&mut utterance_samples),
                    },
                );
            } else {
                utterance_samples.clear();
            }
            stream.reset();
            last_partial.clear();
        } else {
            let raw_text = stream.result().text;
            let text = clean_asr_text(&raw_text);
            if text != last_partial && !text.trim().is_empty() {
                publish_caption(
                    &app,
                    session_id,
                    CaptionOutput::Partial(CaptionEvent {
                        revision,
                        utterance: utterance + 1,
                        seq: 0,
                        app_name: app_name.clone(),
                        text: text.clone(),
                        is_final: false,
                    }),
                );
                last_partial = text;
            }
        }
    }

    // Flush trailing context so the last utterance is not lost mid-word.
    stream.input_finished();
    stream.decode();
    let raw_text = stream.result().text;
    let text = clean_asr_text(&raw_text);
    if !text.trim().is_empty() {
        utterance += 1;
        revision += 1;
        for (seq, piece) in split_caption_pieces(&text).into_iter().enumerate() {
            publish_caption(
                &app,
                session_id,
                CaptionOutput::Final(CaptionEvent {
                    revision,
                    utterance,
                    seq: seq as u32,
                    app_name: app_name.clone(),
                    text: piece,
                    is_final: true,
                }),
            );
        }
        maybe_enqueue_refine(
            &refine_tx,
            &refine_enabled,
            RefineJob {
                utterance,
                pass1_text: text,
                samples: std::mem::take(&mut utterance_samples),
            },
        );
    }
}

/// Queue an utterance for the Whisper pass unless refining is poisoned, the
/// queue is full (refine already behind — the instant text is on screen), or
/// the utterance outlived the refine budget.
fn maybe_enqueue_refine(
    refine_tx: &SyncSender<RefineJob>,
    refine_enabled: &AtomicBool,
    job: RefineJob,
) {
    if !refine_enabled.load(Ordering::SeqCst) {
        return;
    }
    if job.samples.len() as f64 / f64::from(TARGET_RATE) > REFINE_MAX_SECONDS {
        return;
    }
    match refine_tx.try_send(job) {
        Ok(()) => {}
        Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {}
    }
}

fn has_mlx_whisper(python: &std::path::Path) -> bool {
    std::process::Command::new(python)
        .arg("-c")
        .arg("import mlx_whisper")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn resolve_whisper_python() -> PathBuf {
    // 1. Explicit Lumen override environment variables
    for var in ["LUMEN_WHISPER_PYTHON", "LUMEN_PYTHON", "LUMEN_QWEN_PYTHON"] {
        if let Some(val) = std::env::var_os(var).filter(|v| !v.is_empty()) {
            let path = PathBuf::from(val);
            if path.exists() {
                return path;
            }
        }
    }

    // 2. Currently active VirtualEnv or Conda environment
    for var in ["VIRTUAL_ENV", "CONDA_PREFIX"] {
        if let Some(prefix) = std::env::var_os(var).filter(|v| !v.is_empty()) {
            let base = PathBuf::from(prefix);
            let candidate = base.join("bin/python3");
            if candidate.exists() && has_mlx_whisper(&candidate) {
                return candidate;
            }
            let candidate_alt = base.join("bin/python");
            if candidate_alt.exists() && has_mlx_whisper(&candidate_alt) {
                return candidate_alt;
            }
        }
    }

    // 3. Scan standard Lumen central venv and common environment candidates
    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        // Standard Lumen central venv (~/.lumen/venv)
        candidates.push(home.join(".lumen/venv/bin/python3"));
        candidates.push(home.join(".lumen/venv/bin/python"));
        candidates.push(home.join(".venv/bin/python3"));
        candidates.push(home.join(".venv/bin/python"));

        // Common conda and virtualenv search paths
        let conda_env_dirs = [
            home.join(".conda/envs"),
            home.join("miniconda3/envs"),
            home.join("anaconda3/envs"),
            home.join("miniforge3/envs"),
            PathBuf::from("/opt/homebrew/Caskroom/miniconda/base/envs"),
        ];
        for env_dir in conda_env_dirs {
            if let Ok(entries) = std::fs::read_dir(env_dir) {
                for entry in entries.flatten() {
                    let py3 = entry.path().join("bin/python3");
                    if py3.exists() {
                        candidates.push(py3);
                    }
                }
            }
        }

        candidates.push(home.join(".local/bin/python3"));
        candidates.push(PathBuf::from("/opt/homebrew/bin/python3"));
        candidates.push(PathBuf::from("/usr/local/bin/python3"));
        candidates.push(PathBuf::from("/opt/homebrew/Caskroom/miniconda/base/bin/python3"));
    }

    // Return the first candidate that actually has mlx_whisper installed
    for candidate in &candidates {
        if candidate.exists() && has_mlx_whisper(candidate) {
            return candidate.clone();
        }
    }

    // Fallback: preferred default is ~/.lumen/venv/bin/python3 if it exists, otherwise system python3
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let lumen_default = home.join(".lumen/venv/bin/python3");
        if lumen_default.exists() {
            return lumen_default;
        }
    }

    PathBuf::from("python3")
}

fn run_refine_worker(
    app: AppHandle,
    session_id: u64,
    app_name: String,
    rx: Receiver<RefineJob>,
    enabled: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) {
    let python = resolve_whisper_python();
    log::info!("MLX Whisper refine worker started using python: {}", python.display());
    let engine = lumen_asr_engine::MlxWhisperAsr::new(lumen_asr_engine::MlxWhisperConfig::product(
        python,
        lumen_asr_engine::DEFAULT_MLX_WHISPER_MODEL,
        None,
        Duration::from_secs(60),
    ));

    while !stop.load(Ordering::SeqCst) {
        let job = match rx.recv_timeout(IDLE_POLL) {
            Ok(job) => job,
            Err(_) => continue,
        };
        let request = lumen_asr_engine::AsrRequest::new(job.samples, TARGET_RATE);
        match tauri::async_runtime::block_on(engine.transcribe(request)) {
            Ok(result) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                let text = result.text.trim().to_string();
                if !text.is_empty() && text != job.pass1_text {
                    log::info!(
                        "Utterance {} refined by Whisper: {:?} -> {:?}",
                        job.utterance,
                        job.pass1_text,
                        text
                    );
                    publish_caption(
                        &app,
                        session_id,
                        CaptionOutput::Refine(CaptionRefineEvent {
                            utterance: job.utterance,
                            app_name: app_name.clone(),
                            text,
                        }),
                    );
                }
            }
            Err(err) => {
                // First hard failure (missing python env, missing package…)
                // poisons the pass permanently: log once, degrade to
                // Paraformer-only captions.
                if enabled.swap(false, Ordering::SeqCst) {
                    log::warn!("caption refine disabled (MLX Whisper unavailable): {err}");
                }
            }
        }
    }
}

/// Clean common streaming ASR repetition artifacts (adjacent duplicate words).
fn clean_asr_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let words: Vec<&str> = trimmed.split_whitespace().collect();
    if words.is_empty() {
        return String::new();
    }
    let mut cleaned = Vec::with_capacity(words.len());
    let mut prev_word_lower = String::new();
    for word in words {
        let clean = word.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
        if !clean.is_empty() && clean == prev_word_lower {
            continue;
        }
        prev_word_lower = clean;
        cleaned.push(word);
    }
    cleaned.join(" ")
}

/// Computes visual display width (CJK = 2, ASCII/Latin = 1).
fn visual_width(s: &str) -> usize {
    s.chars().map(|c| if c.is_ascii() { 1 } else { 2 }).sum()
}

/// Split a finalized utterance into caption-shaped pieces at sentence
/// punctuation; cuts long pieces at natural word boundaries or punctuation.
fn split_caption_pieces(text: &str) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let chars: Vec<char> = trimmed.chars().collect();
    let len = chars.len();
    let mut sentences: Vec<String> = Vec::new();
    let mut current = String::new();

    let mut i = 0;
    while i < len {
        let ch = chars[i];
        current.push(ch);

        let is_cjk_end = matches!(ch, '。' | '！' | '？' | '；' | '…');
        let is_latin_excl_or_q = matches!(ch, '!' | '?' | ';')
            && (i + 1 == len || chars[i + 1].is_whitespace() || matches!(chars[i + 1], '"' | '\''));
        let is_latin_period = if ch == '.' {
            let prev_digit = i > 0 && chars[i - 1].is_ascii_digit();
            let next_digit = i + 1 < len && chars[i + 1].is_ascii_digit();
            let is_decimal = prev_digit && next_digit;
            let followed_by_space_or_end = i + 1 == len || chars[i + 1].is_whitespace() || matches!(chars[i + 1], '"' | '\'');
            !is_decimal && followed_by_space_or_end
        } else {
            false
        };

        // Long pause at comma
        let is_long_comma = matches!(ch, '，' | ',')
            && visual_width(&current) >= 40
            && (i + 1 == len || chars[i + 1].is_whitespace());

        if is_cjk_end || is_latin_excl_or_q || is_latin_period || is_long_comma {
            let s = current.trim();
            if !s.is_empty() {
                sentences.push(s.to_string());
            }
            current.clear();
        }

        i += 1;
    }

    let remaining = current.trim();
    if !remaining.is_empty() {
        sentences.push(remaining.to_string());
    }

    let mut pieces: Vec<String> = Vec::new();
    for sentence in sentences {
        if visual_width(&sentence) <= CAPTION_MAX_VISUAL_WIDTH {
            pieces.push(sentence);
        } else {
            split_long_sentence(&sentence, &mut pieces, CAPTION_MAX_VISUAL_WIDTH);
        }
    }
    pieces
}

fn split_long_sentence(sentence: &str, pieces: &mut Vec<String>, max_width: usize) {
    let mut remaining: String = sentence.trim().to_string();
    while visual_width(&remaining) > max_width {
        let chars: Vec<char> = remaining.chars().collect();
        let total_chars = chars.len();

        // Find character index where visual width hits max_width
        let mut limit_char_idx = total_chars;
        let mut width_acc = 0;
        for (idx, &c) in chars.iter().enumerate() {
            width_acc += if c.is_ascii() { 1 } else { 2 };
            if width_acc > max_width {
                limit_char_idx = idx;
                break;
            }
        }

        // Look for the best cut point backwards (space or punctuation)
        let min_cut = (limit_char_idx / 2).max(1);
        let mut best_cut = None;
        for idx in (min_cut..=limit_char_idx.min(total_chars - 1)).rev() {
            let c = chars[idx];
            if c.is_whitespace() || matches!(c, '，' | ',' | '、' | '—' | '；' | ';') {
                best_cut = Some(idx + 1);
                break;
            }
        }

        let cut_pos = best_cut.unwrap_or(limit_char_idx.max(1));
        let head: String = chars[..cut_pos].iter().collect();
        let tail: String = chars[cut_pos..].iter().collect();
        let head_trimmed = head.trim();
        if !head_trimmed.is_empty() {
            pieces.push(head_trimmed.to_string());
        }
        remaining = tail.trim().to_string();
    }
    let last = remaining.trim();
    if !last.is_empty() {
        pieces.push(last.to_string());
    }
}

/// Streaming Paraformer dir iff macOS + model installed. `None` everywhere
/// else — the caller surfaces "not ready" instead of failing at runtime.
fn streaming_dir_if_ready() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let dir = default_streaming_dir();
    lumen_models::paraformer_streaming_ready(&dir).then_some(dir)
}

fn default_streaming_dir() -> PathBuf {
    lumen_models::default_paraformer_streaming_dir()
}

pub fn load_streaming_recognizer() -> Result<lumen_asr_engine::StreamingRecognizer, String> {
    let streaming_dir = streaming_dir_if_ready().ok_or_else(|| {
        format!(
            "streaming Paraformer model not found under {} — install it via Lumen ASR's model settings, then retry",
            default_streaming_dir().display()
        )
    })?;
    let paths = lumen_asr_engine::ParaformerStreamingModelPaths::discover(&streaming_dir).ok_or_else(|| {
        format!(
            "streaming Paraformer model files missing under {}",
            streaming_dir.display()
        )
    })?;
    let config = lumen_asr_engine::StreamingEndpointConfig {
        rule1_min_trailing_silence: 1.5,
        rule2_min_trailing_silence: 0.55,
        rule3_min_utterance_length: 6.5,
        num_threads: 2,
    };
    lumen_asr_engine::StreamingRecognizer::with_config(paths, config)
        .map_err(|error| format!("could not load streaming model: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{
        clean_asr_text, split_caption_pieces, visual_width, CaptionEvent, CaptionEventJournal,
        CaptionOutput,
    };

    fn partial(revision: u64, text: &str) -> CaptionOutput {
        CaptionOutput::Partial(CaptionEvent {
            revision,
            utterance: 1,
            seq: 0,
            app_name: "Preview".into(),
            text: text.into(),
            is_final: false,
        })
    }

    #[test]
    fn journal_replays_only_caption_events_a_webview_missed() {
        let mut journal = CaptionEventJournal::default();
        let session_id = journal.begin_session();
        let first = journal.push(partial(1, "first"));
        let second = journal.push(partial(2, "second"));

        let snapshot = journal.snapshot_since(Some(session_id), first.event_id);

        assert_eq!(snapshot.session_id, session_id);
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].event_id, second.event_id);
    }

    #[test]
    fn journal_never_replays_events_from_an_old_caption_session() {
        let mut journal = CaptionEventJournal::default();
        let old_session = journal.begin_session();
        journal.push(partial(1, "old"));
        let new_session = journal.begin_session();
        let current = journal.push(partial(1, "current"));

        let snapshot = journal.snapshot_since(Some(old_session), 999);

        assert_ne!(new_session, old_session);
        assert_eq!(snapshot.session_id, new_session);
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].event_id, current.event_id);
    }

    #[test]
    fn ended_or_replaced_sessions_reject_late_worker_output() {
        let mut journal = CaptionEventJournal::default();
        let old_session = journal.begin_session();
        journal.end_session();
        assert!(journal
            .push_for_session(old_session, partial(2, "late"))
            .is_none());

        let new_session = journal.begin_session();
        assert!(journal
            .push_for_session(old_session, partial(3, "stale"))
            .is_none());
        assert!(journal
            .push_for_session(new_session, partial(4, "current"))
            .is_some());
    }

    #[test]
    fn splits_at_sentence_punctuation() {
        let pieces = split_caption_pieces("今天天气很好。我们去公园吧！真的吗");
        assert_eq!(pieces, vec!["今天天气很好。", "我们去公园吧！", "真的吗"]);
    }

    #[test]
    fn splits_english_sentences_naturally() {
        let pieces = split_caption_pieces("Hello everyone, welcome! Today we will discuss Rust. Are you ready?");
        assert_eq!(
            pieces,
            vec![
                "Hello everyone, welcome!",
                "Today we will discuss Rust.",
                "Are you ready?"
            ]
        );
    }

    #[test]
    fn preserves_decimals_in_english_sentences() {
        let pieces = split_caption_pieces("The price is $3.14 per unit. Version 2.0 is out!");
        assert_eq!(
            pieces,
            vec!["The price is $3.14 per unit.", "Version 2.0 is out!"]
        );
    }

    #[test]
    fn cleans_stuttered_asr_repeated_words() {
        let text = "in the way that steve jobs art art in the he ran's company company to way they heating";
        let cleaned = clean_asr_text(text);
        assert_eq!(
            cleaned,
            "in the way that steve jobs art in the he ran's company to way they heating"
        );
    }

    #[test]
    fn cuts_oversized_english_without_slicing_words() {
        let text = "We are currently implementing a high performance real-time audio and speech translation engine that runs entirely on Apple Silicon Metal";
        let pieces = split_caption_pieces(text);
        assert!(pieces.len() >= 2);
        for piece in &pieces {
            assert!(visual_width(piece) <= 60);
            // Verify no partial broken word at edges
            assert!(!piece.starts_with(' '));
            assert!(!piece.ends_with(' '));
        }
    }

    #[test]
    fn hard_cuts_oversized_cjk_pieces() {
        let text = "一".repeat(150);
        let pieces = split_caption_pieces(&text);
        assert!(pieces.len() >= 3);
        assert!(pieces.iter().all(|p| visual_width(p) <= 60));
    }
}

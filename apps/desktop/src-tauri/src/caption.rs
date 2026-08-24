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

/// Soft caption width before hard-cutting (CJK reading width, cluster
/// research: 1–2 lines × ~30–42 chars).
const CAPTION_MAX_CHARS: usize = 42;

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
    /// 16 kHz mono f32, the exact samples pass 1 decoded.
    samples: Vec<f32>,
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
            let text = stream.result().text;
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
                        samples: std::mem::take(&mut utterance_samples),
                    },
                );
            } else {
                utterance_samples.clear();
            }
            stream.reset();
            last_partial.clear();
        } else {
            let text = stream.result().text;
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
    let text = stream.result().text;
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

fn run_refine_worker(
    app: AppHandle,
    session_id: u64,
    app_name: String,
    rx: Receiver<RefineJob>,
    enabled: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) {
    // Python resolution follows lumen-asr's convention: explicit env override,
    // otherwise the ambient interpreter (needs `mlx_whisper` importable —
    // same env the ASR app's Qwen/MLX workers use).
    let python = std::env::var_os("LUMEN_QWEN_PYTHON")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("python3"));
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
                if !text.is_empty() {
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

/// Split a finalized utterance into caption-shaped pieces at sentence
/// punctuation; hard-cut any piece wider than [`CAPTION_MAX_CHARS`].
fn split_caption_pieces(text: &str) -> Vec<String> {
    let mut pieces: Vec<String> = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if matches!(ch, '。' | '！' | '？' | '…' | '；' | '!' | '?' | '.' | ';') {
            push_piece(&mut pieces, &mut current);
        }
    }
    push_piece(&mut pieces, &mut current);
    pieces
}

fn push_piece(pieces: &mut Vec<String>, current: &mut String) {
    let trimmed = current.trim();
    if trimmed.is_empty() {
        current.clear();
        return;
    }
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= CAPTION_MAX_CHARS {
        pieces.push(trimmed.to_string());
    } else {
        for chunk in chars.chunks(CAPTION_MAX_CHARS) {
            pieces.push(chunk.iter().collect());
        }
    }
    current.clear();
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
    lumen_asr_engine::StreamingRecognizer::from_dir(&streaming_dir)
        .map_err(|error| format!("could not load streaming model: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{split_caption_pieces, CaptionEvent, CaptionEventJournal, CaptionOutput};

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
    fn hard_cuts_oversized_pieces() {
        let text = "一".repeat(90);
        let pieces = split_caption_pieces(&text);
        assert_eq!(pieces.len(), 3);
        assert!(pieces.iter().all(|p| p.chars().count() <= 42));
    }
}

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

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

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

    pub fn start(&self, app: AppHandle, bundle_id: String, app_name: String) -> Result<(), String> {
        let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
        // Defensive: reap any stopped-but-unjoined worker first.
        if let Some(mut worker) = guard.take() {
            worker.shutdown();
        }

        let streaming_dir = streaming_dir_if_ready().ok_or_else(|| {
            format!(
                "streaming Paraformer model not found under {} — install it via Lumen ASR's model settings, then retry",
                default_streaming_dir().display()
            )
        })?;

        let (tx, rx) = std::sync::mpsc::sync_channel(AUDIO_QUEUE_CAPACITY);
        let sink: lumen_platform_macos::SystemAudioSink = Arc::new(move |samples: &[f32]| {
            // Drop-on-full is the designed backpressure: a momentarily lagging
            // caption beats unbounded memory when the model stalls.
            match tx.try_send(samples.to_vec()) {
                Ok(()) => {}
                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {}
            }
        });

        let target = lumen_platform_macos::SystemAudioTarget::new([bundle_id]);
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
                    run_refine_worker(app, app_name, refine_rx, enabled, stop);
                })
                .ok()
        };

        let handle = std::thread::Builder::new()
            .name("lumen-caption".into())
            .spawn(move || {
                run_worker(
                    app,
                    streaming_dir,
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
        if let Some(handle) = self.refine_handle.take() {
            let _ = handle.join();
        }
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
    streaming_dir: PathBuf,
    app_name: String,
    capture_rate: u32,
    rx: std::sync::mpsc::Receiver<Vec<f32>>,
    refine_tx: SyncSender<RefineJob>,
    refine_enabled: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
) {
    let recognizer = match lumen_asr_engine::StreamingRecognizer::from_dir(&streaming_dir) {
        Ok(r) => r,
        Err(e) => {
            log::error!("caption worker: could not load streaming Paraformer: {e}");
            let _ = app.emit(
                "caption-error",
                format!("could not load streaming model: {e}"),
            );
            return;
        }
    };
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
                    let _ = app.emit(
                        "caption-final",
                        CaptionEvent {
                            revision,
                            utterance,
                            seq: seq as u32,
                            app_name: app_name.clone(),
                            text: piece,
                            is_final: true,
                        },
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
                let _ = app.emit(
                    "caption-partial",
                    CaptionEvent {
                        revision,
                        utterance: utterance + 1,
                        seq: 0,
                        app_name: app_name.clone(),
                        text: text.clone(),
                        is_final: false,
                    },
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
            let _ = app.emit(
                "caption-final",
                CaptionEvent {
                    revision,
                    utterance,
                    seq: seq as u32,
                    app_name: app_name.clone(),
                    text: piece,
                    is_final: true,
                },
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
                let text = result.text.trim().to_string();
                if !text.is_empty() {
                    let _ = app.emit(
                        "caption-refine",
                        CaptionRefineEvent {
                            utterance: job.utterance,
                            app_name: app_name.clone(),
                            text,
                        },
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

#[cfg(test)]
mod tests {
    use super::split_caption_pieces;

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
